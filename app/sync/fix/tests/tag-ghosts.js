describe("sync/fix/tag-ghosts", function () {
  var Tags = require("models/tags");
  var Entry = require("models/entry");
  var client = require("models/client");
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
    spyOn(Entry, "get").and.callFake(function (_blogID, entryID, callback) {
      callback({ id: entryID });
    });
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
    spyOn(Entry, "get");

    var multi = fakeMulti();
    spyOn(client, "multi").and.returnValue(multi);

    fixTagGhosts({ id: "blog-id" }, function (err, report) {
      expect(err).toBeNull();
      expect(report).toEqual([["EMPTY TAG", { slug: "ghost-tag" }]]);
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
    spyOn(Entry, "get").and.callFake(function (_blogID, entryID, callback) {
      callback(undefined);
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

  it("re-keys an entry stored under a stale id within a tag", function (done) {
    var entry = { id: "/new-path", dateStamp: 1234 };

    spyOn(Tags, "list").and.callFake(function (_blogID, callback) {
      callback(null, [{ slug: "chairs" }]);
    });
    spyOn(Tags, "get").and.callFake(function (_blogID, slug, callback) {
      callback(null, ["/old-path"]);
    });
    spyOn(Entry, "get").and.callFake(function (_blogID, entryID, callback) {
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
    spyOn(Entry, "get");

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
});
