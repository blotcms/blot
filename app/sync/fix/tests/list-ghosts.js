describe("sync/fix/list-ghosts", function () {
  var Entry = require("models/entry");
  var Entries = require("models/entries");
  var client = require("models/client");
  var entryKey = require("models/entry/key").entry;
  var fixListGhosts = require("../list-ghosts");
  // Resolves to { err, report } instead of rejecting, so a spec can
  // assert on either
  const settle_fixListGhosts = (...args) =>
    fixListGhosts(...args).then(
      (report) => ({ err: null, report }),
      (err) => ({ err, report: undefined })
    );

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

  it("resolves missing entries without rejection and continues mismatch cleanup", async function () {
    spyOn(Entries, "pruneMissing").and.callFake(async function () {});

    spyOn(client, "zRange").and.callFake(function (key) {
      if (key === "blog:blog-id:entries") {
        return Promise.resolve(["existing-id", "missing-id"]);
      }

      return Promise.resolve([]);
    });

    spyOn(client, "zRem").and.returnValue(Promise.resolve(1));
    spyOn(client, "del").and.returnValue(Promise.resolve(1));
    spyOn(client, "get").and.returnValue(
      Promise.resolve(JSON.stringify({ id: "moved-id", title: "Moved" }))
    );

    // The batched read finds "existing-id" stored under the wrong key (a
    // mismatch) and finds nothing at all for "missing-id".
    stubMGet("blog-id", {
      "existing-id": { id: "moved-id", title: "Moved" },
    });

    spyOn(Entry, "get").and.callFake(function (_blogID, id) {
      if (id === "existing-id") {
        return Promise.resolve({ id: "moved-id", title: "Moved" });
      }

      return Promise.resolve(undefined);
    });

    spyOn(Entry, "set").and.callFake(async function (_blogID, id, entry) {
      expect(id).toBe("moved-id");
      expect(entry.id).toBe("moved-id");
    });

    const { err, report } = await settle_fixListGhosts({ id: "blog-id" });
    expect(err).toBeNull();

    // Only the mismatched id needs a full re-fetch; the missing one is
    // already known to be a ghost from the batched read.
    expect(Entry.get.calls.allArgs()).toEqual([["blog-id", "existing-id"]]);

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
  });

  it("restores the stale key's raw value if re-saving the entry fails", async function () {
    spyOn(Entries, "pruneMissing").and.callFake(async function () {});

    spyOn(client, "zRange").and.callFake(function (key) {
      if (key === "blog:blog-id:entries") {
        return Promise.resolve(["existing-id"]);
      }

      return Promise.resolve([]);
    });

    spyOn(client, "zRem").and.returnValue(Promise.resolve(1));
    spyOn(client, "del").and.returnValue(Promise.resolve(1));

    var rawValue = JSON.stringify({ id: "moved-id", title: "Moved" });
    spyOn(client, "get").and.returnValue(Promise.resolve(rawValue));
    spyOn(client, "set").and.returnValue(Promise.resolve("OK"));

    stubMGet("blog-id", {
      "existing-id": { id: "moved-id", title: "Moved" },
    });

    spyOn(Entry, "get").and.callFake(function (_blogID, id) {
      return Promise.resolve({ id: "moved-id", title: "Moved" });
    });

    var setEntryError = new Error("set entry failed");
    spyOn(Entry, "set").and.callFake(async function (_blogID, id, entry) {
      throw setEntryError;
    });

    const { err } = await settle_fixListGhosts({ id: "blog-id" });
    expect(err).toBe(setEntryError);

    // The raw value read before the delete is written back under the
    // stale id so the entry isn't left unstored.
    expect(client.set).toHaveBeenCalledWith(
      entryKey("blog-id", "existing-id"),
      rawValue
    );
  });

  it("propagates the re-save error when restoring the stale key also fails", async function () {
    spyOn(console, "error");
    spyOn(Entries, "pruneMissing").and.callFake(async function () {});

    spyOn(client, "zRange").and.callFake(function (key) {
      if (key === "blog:blog-id:entries") {
        return Promise.resolve(["existing-id"]);
      }

      return Promise.resolve([]);
    });

    spyOn(client, "zRem").and.returnValue(Promise.resolve(1));
    spyOn(client, "del").and.returnValue(Promise.resolve(1));
    spyOn(client, "get").and.returnValue(
      Promise.resolve(JSON.stringify({ id: "moved-id" }))
    );
    spyOn(client, "set").and.callFake(function () {
      return Promise.reject(new Error("restore failed"));
    });

    stubMGet("blog-id", { "existing-id": { id: "moved-id" } });

    spyOn(Entry, "get").and.callFake(function (_blogID, id) {
      return Promise.resolve({ id: "moved-id" });
    });

    var setEntryError = new Error("set entry failed");
    spyOn(Entry, "set").and.callFake(async function (_blogID, id, entry) {
      throw setEntryError;
    });

    const { err } = await settle_fixListGhosts({ id: "blog-id" });
    expect(err).toBe(setEntryError);
    expect(console.error).toHaveBeenCalled();
  });

  it("fetches an id shared by several lists from Redis only once", async function () {
    spyOn(Entries, "pruneMissing").and.callFake(async function () {});

    spyOn(client, "zRange").and.callFake(function (key) {
      if (key === "blog:blog-id:all" || key === "blog:blog-id:pages") {
        return Promise.resolve(["/chair"]);
      }

      return Promise.resolve([]);
    });

    stubMGet("blog-id", { "/chair": { id: "/chair" } });
    spyOn(client, "zRem");

    const { err, report } = await settle_fixListGhosts({ id: "blog-id" });
    expect(err).toBeNull();
    expect(report).toEqual([]);
    expect(client.mGet.calls.count()).toBe(1);
    expect(client.mGet.calls.argsFor(0)[0]).toEqual([
      entryKey("blog-id", "/chair"),
    ]);
  });
});
