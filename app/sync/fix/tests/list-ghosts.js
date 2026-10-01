describe("sync/fix/list-ghosts", function () {
  var Entry = require("models/entry");
  var Entries = require("models/entries");
  var client = require("models/client");
  var entryKey = require("models/entry/key").entry;
  var fixListGhosts = require("../list-ghosts");

  // Stubs client.mGet the way list-ghosts' batched read calls it: one MGET
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

  it("resolves missing entries without rejection and continues mismatch cleanup", function (done) {
    spyOn(Entries, "pruneMissing").and.callFake(function (_blogID, callback) {
      callback(null);
    });

    spyOn(client, "zRange").and.callFake(function (key) {
      if (key === "blog:blog-id:entries") {
        return Promise.resolve(["existing-id", "missing-id"]);
      }

      return Promise.resolve([]);
    });

    spyOn(client, "zRem").and.returnValue(Promise.resolve(1));
    spyOn(client, "del").and.returnValue(Promise.resolve(1));

    // The batched read finds "existing-id" stored under the wrong key (a
    // mismatch) and finds nothing at all for "missing-id".
    stubMGet("blog-id", {
      "existing-id": { id: "moved-id", title: "Moved" },
    });

    // The batched read finds "existing-id" stored under the wrong key (a
    // mismatch) and finds nothing at all for "missing-id".
    stubMGet("blog-id", {
      "existing-id": { id: "moved-id", title: "Moved" },
    });

    spyOn(Entry, "get").and.callFake(function (_blogID, id, callback) {
      if (id === "existing-id") {
        return callback({ id: "moved-id", title: "Moved" });
      }

      return callback(undefined);
    });

    spyOn(Entry, "set").and.callFake(function (_blogID, id, entry, callback) {
      expect(id).toBe("moved-id");
      expect(entry.id).toBe("moved-id");
      callback(null);
    });

    fixListGhosts({ id: "blog-id" }, function (err, report) {
      expect(err).toBeNull();

      // Only the mismatched id needs a full re-fetch; the missing one is
      // already known to be a ghost from the batched read.
      expect(Entry.get.calls.allArgs()).toEqual([
        ["blog-id", "existing-id", jasmine.any(Function)],
      ]);

      expect(client.zRem.calls.allArgs()).toEqual([
        ["blog:blog-id:entries", "existing-id"],
        ["blog:blog-id:entries", "missing-id"],
      ]);

      expect(Entry.set.calls.count()).toBe(1);
      expect(report).toEqual([
        ["entries", "MISMATCH", "existing-id"],
        ["entries", "MISMATCH", "missing-id"],
      ]);

      // The orphaned raw key at the stale id ("existing-id") is deleted
      // before the entry is re-saved under its real id.
      expect(client.del).toHaveBeenCalledWith(entryKey("blog-id", "existing-id"));

      done();
    });
  });

  it("fetches an id shared by several lists from Redis only once", function (done) {
    spyOn(Entries, "pruneMissing").and.callFake(function (_blogID, callback) {
      callback(null);
    });

    spyOn(client, "zRange").and.callFake(function (key) {
      if (key === "blog:blog-id:all" || key === "blog:blog-id:pages") {
        return Promise.resolve(["/chair"]);
      }

      return Promise.resolve([]);
    });

    stubMGet("blog-id", { "/chair": { id: "/chair" } });
    spyOn(client, "zRem");

    fixListGhosts({ id: "blog-id" }, function (err, report) {
      expect(err).toBeNull();
      expect(report).toEqual([]);
      expect(client.mGet.calls.count()).toBe(1);
      expect(client.mGet.calls.argsFor(0)[0]).toEqual([
        entryKey("blog-id", "/chair"),
      ]);
      done();
    });
  });

  it("fetches an id shared by several lists from Redis only once", function (done) {
    spyOn(Entries, "pruneMissing").and.callFake(function (_blogID, callback) {
      callback(null);
    });

    spyOn(client, "zRange").and.callFake(function (key) {
      if (key === "blog:blog-id:all" || key === "blog:blog-id:pages") {
        return Promise.resolve(["/chair"]);
      }

      return Promise.resolve([]);
    });

    stubMGet("blog-id", { "/chair": { id: "/chair" } });
    spyOn(client, "zRem");

    fixListGhosts({ id: "blog-id" }, function (err, report) {
      expect(err).toBeNull();
      expect(report).toEqual([]);
      expect(client.mGet.calls.count()).toBe(1);
      expect(client.mGet.calls.argsFor(0)[0]).toEqual([
        entryKey("blog-id", "/chair"),
      ]);
      done();
    });
  });
});
