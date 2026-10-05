describe("sync/fix/tag-ghosts", function () {
  var Tags = require("models/tags");
  var Entry = require("models/entry");
  var client = require("models/client");
  var entryKey = require("models/entry/key").entry;
  var fixTagGhosts = require("../tag-ghosts");

  function fakeMulti() {
    return {
      sRem: jasmine.createSpy("sRem"),
      del: jasmine.createSpy("del"),
      zRem: jasmine.createSpy("zRem"),
      rename: jasmine.createSpy("rename"),
      zAdd: jasmine.createSpy("zAdd"),
      exec: jasmine.createSpy("exec").and.callFake(function (callback) {
        callback(null);
      }),
    };
  }

  // Stubs client.mGet the way tag-ghosts' batched read calls it: one MGET
  // over the requested ids' Redis keys, resolved from a map of
  // id -> stored entry (or omitted/undefined for a missing entry).
  function stubMGet(blogID, entriesByID) {
    spyOn(client, "mGet").and.callFake(function (keys) {
      return Promise.resolve(
        keys.map(function (key) {
          var id = Object.keys(entriesByID).find(function (candidateID) {
            return entryKey(blogID, candidateID) === key;
          });
          var entry = id && entriesByID[id];
          return entry ? JSON.stringify(entry) : null;
        })
      );
    });
  }

  it("propagates an error from Tags.list instead of silently reporting nothing", function (done) {
    var listError = new Error("tags.list exploded");

    spyOn(Tags, "list").and.callFake(function (_blogID, callback) {
      callback(listError);
    });
    spyOn(Tags, "get");
    spyOn(client, "multi");

    fixTagGhosts({ id: "blog-id" }, function (err, report) {
      expect(err).toBe(listError);
      expect(report).toBeUndefined();
      expect(Tags.get).not.toHaveBeenCalled();
      done();
    });
  });

  it("does nothing when every tag has entries that all match their stored id", function (done) {
    spyOn(Tags, "list").and.callFake(function (_blogID, callback) {
      callback(null, [{ slug: "chairs" }]);
    });
    spyOn(Tags, "get").and.callFake(function (_blogID, slug, callback) {
      callback(null, ["/chair"]);
    });
    stubMGet("blog-id", { "/chair": { id: "/chair" } });
    spyOn(client, "multi");

    fixTagGhosts({ id: "blog-id" }, function (err, report) {
      expect(err).toBeNull();
      expect(report).toEqual([]);
      expect(client.multi).not.toHaveBeenCalled();
      done();
    });
  });

  it("deletes a tag with no entries", function (done) {
    spyOn(Tags, "list").and.callFake(function (_blogID, callback) {
      callback(null, [{ slug: "ghost-tag" }]);
    });
    spyOn(Tags, "get").and.callFake(function (_blogID, slug, callback) {
      callback(null, []);
    });
    spyOn(client, "mGet");

    var multi = fakeMulti();
    spyOn(client, "multi").and.returnValue(multi);

    fixTagGhosts({ id: "blog-id" }, function (err, report) {
      expect(err).toBeNull();
      expect(report).toEqual([["EMPTY TAG", { slug: "ghost-tag" }]]);
      expect(client.mGet).not.toHaveBeenCalled();
      expect(multi.sRem).toHaveBeenCalledWith(
        Tags.key.all("blog-id"),
        "ghost-tag"
      );
      expect(multi.del).toHaveBeenCalledWith(
        Tags.key.sortedTag("blog-id", "ghost-tag")
      );
      done();
    });
  });

  it("removes an entry id from a tag when the entry no longer exists", function (done) {
    spyOn(Tags, "list").and.callFake(function (_blogID, callback) {
      callback(null, [{ slug: "chairs" }]);
    });
    spyOn(Tags, "get").and.callFake(function (_blogID, slug, callback) {
      callback(null, ["/missing-entry"]);
    });
    stubMGet("blog-id", {});
    spyOn(Entry, "get").and.callFake(function () {
      throw new Error("Entry.get should not be called for a MISSING id");
    });

    var multi = fakeMulti();
    spyOn(client, "multi").and.returnValue(multi);

    fixTagGhosts({ id: "blog-id" }, function (err, report) {
      expect(err).toBeNull();
      expect(report).toEqual([["MISSING", "/missing-entry"]]);
      expect(multi.zRem).toHaveBeenCalledWith(
        Tags.key.sortedTag("blog-id", "chairs"),
        "/missing-entry"
      );
      done();
    });
  });

  it("re-reads a missing entry for each tag, so one restored mid-run is kept", function (done) {
    var stored = {};

    spyOn(Tags, "list").and.callFake(function (_blogID, callback) {
      callback(null, [{ slug: "first" }, { slug: "second" }]);
    });
    spyOn(Tags, "get").and.callFake(function (_blogID, slug, callback) {
      callback(null, ["/restored"]);
    });
    stubMGet("blog-id", stored);

    var multi = fakeMulti();
    // A concurrent sync restores the entry right after the first tag's prune.
    multi.exec.and.callFake(function (callback) {
      stored["/restored"] = { id: "/restored" };
      callback(null);
    });
    spyOn(client, "multi").and.returnValue(multi);

    fixTagGhosts({ id: "blog-id" }, function (err, report) {
      expect(err).toBeNull();
      expect(report).toEqual([["MISSING", "/restored"]]);
      expect(client.mGet.calls.count()).toBe(2);
      expect(multi.zRem.calls.count()).toBe(1);
      expect(multi.zRem).toHaveBeenCalledWith(
        Tags.key.sortedTag("blog-id", "first"),
        "/restored"
      );
      done();
    });
  });

  it("re-keys an entry stored under a stale id within a tag", function (done) {
    var entry = { id: "/new-path", dateStamp: 1234 };

    spyOn(Tags, "list").and.callFake(function (_blogID, callback) {
      callback(null, [{ slug: "chairs" }]);
    });
    spyOn(Tags, "get").and.callFake(function (_blogID, slug, callback) {
      callback(null, ["/old-path"]);
    });
    // The batched read sees the mismatch (stored id != requested id)
    // first; the check then re-fetches the full entry via Entry.get only
    // for this one mismatched id.
    stubMGet("blog-id", { "/old-path": entry });
    spyOn(Entry, "get").and.callFake(function (_blogID, entryID, callback) {
      expect(entryID).toBe("/old-path");
      callback(entry);
    });
    spyOn(Entry, "set").and.callFake(function (blogID, id, updatedEntry, callback) {
      expect(id).toBe("/new-path");
      expect(updatedEntry).toBe(entry);
      callback(null);
    });

    var multi = fakeMulti();
    spyOn(client, "multi").and.returnValue(multi);

    fixTagGhosts({ id: "blog-id" }, function (err, report) {
      expect(err).toBeNull();
      expect(report).toEqual([["MISMATCH", "/old-path", "/new-path"]]);
      expect(multi.rename).toHaveBeenCalledWith(
        Tags.key.entry("blog-id", "/old-path"),
        Tags.key.entry("blog-id", "/new-path")
      );
      expect(multi.zRem).toHaveBeenCalledWith(
        Tags.key.sortedTag("blog-id", "chairs"),
        "/old-path"
      );
      expect(multi.zAdd).toHaveBeenCalledWith(
        Tags.key.sortedTag("blog-id", "chairs"),
        { score: 1234, value: "/new-path" }
      );
      expect(Entry.set).toHaveBeenCalled();
      done();
    });
  });

  it("propagates transaction rejections for empty-tag cleanup", function (done) {
    var execError = new Error("exec exploded");

    spyOn(Tags, "list").and.callFake(function (_blogID, callback) {
      callback(null, [{ slug: "ghost-tag" }]);
    });
    spyOn(Tags, "get").and.callFake(function (_blogID, _slug, callback) {
      callback(null, []);
    });
    spyOn(client, "mGet");

    var multi = {
      sRem: jasmine.createSpy("sRem"),
      del: jasmine.createSpy("del"),
      exec: jasmine.createSpy("exec").and.callFake(function (callback) {
        callback(execError);
      }),
    };

    spyOn(client, "multi").and.returnValue(multi);

    fixTagGhosts({ id: "blog-id" }, function (err, report) {
      expect(err).toBe(execError);
      expect(report).toBeUndefined();
      expect(client.multi).toHaveBeenCalled();
      expect(multi.sRem).toHaveBeenCalled();
      expect(multi.del).toHaveBeenCalled();
      done();
    });
  });

  it("fetches an entry referenced by several tags from Redis only once", function (done) {
    spyOn(Tags, "list").and.callFake(function (_blogID, callback) {
      callback(null, [{ slug: "chairs" }, { slug: "furniture" }, { slug: "sale" }]);
    });
    spyOn(Tags, "get").and.callFake(function (_blogID, slug, callback) {
      // The same entry, "/chair", is a member of all three tags.
      callback(null, ["/chair"]);
    });
    stubMGet("blog-id", { "/chair": { id: "/chair" } });
    spyOn(client, "multi");

    fixTagGhosts({ id: "blog-id" }, function (err, report) {
      expect(err).toBeNull();
      expect(report).toEqual([]);
      // One MGET batch call total for the whole run, not one per tag.
      expect(client.mGet.calls.count()).toBe(1);
      expect(client.mGet.calls.argsFor(0)[0]).toEqual([
        entryKey("blog-id", "/chair"),
      ]);
      done();
    });
  });
});
