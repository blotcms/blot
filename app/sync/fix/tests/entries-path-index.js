describe("sync/fix/entries-path-index", function () {
  var client = require("models/client");
  var pathIndex = require("models/entries/pathIndex");
  var fixEntriesPathIndex = require("../entries-path-index");
  // Resolves to { err, report } instead of rejecting, so a spec can
  // assert on either
  const settle_fixEntriesPathIndex = (...args) =>
    fixEntriesPathIndex(...args).then(
      (report) => ({ err: null, report }),
      (err) => ({ err, report: undefined })
    );

  it("does nothing when entry count and path index count match", async function () {
    var zcard = spyOn(client, "zCard").and.returnValues(
      Promise.resolve("2"),
      Promise.resolve("2")
    );
    spyOn(pathIndex, "backfillIndex");

    const { err, report: changes } = await settle_fixEntriesPathIndex({
      id: "blog-id",
    });
    expect(err).toBeNull();
    expect(changes).toEqual([]);
    expect(zcard.calls.count()).toBe(2);
    expect(pathIndex.backfillIndex).not.toHaveBeenCalled();
  });

  it("backfills the index when counts do not match", async function () {
    spyOn(client, "zCard").and.returnValues(
      Promise.resolve("5"),
      Promise.resolve("3")
    );
    spyOn(pathIndex, "backfillIndex").and.callFake(async function (blogID) {
      expect(blogID).toBe("blog-id");
      return 5;
    });

    const { err, report: changes } = await settle_fixEntriesPathIndex({
      id: "blog-id",
    });
    expect(err).toBeNull();
    expect(changes).toEqual([
      ["MISMATCH", { entries: 5, pathIndex: 3 }],
      ["BACKFILLED", 5],
    ]);
    expect(pathIndex.backfillIndex).toHaveBeenCalled();
  });

  it("returns errors from backfill when counts do not match", async function () {
    var backfillError = new Error("backfill exploded");

    spyOn(client, "zCard").and.returnValues(
      Promise.resolve("5"),
      Promise.resolve("3")
    );
    spyOn(pathIndex, "backfillIndex").and.callFake(async function () {
      throw backfillError;
    });

    const { err, report: changes } = await settle_fixEntriesPathIndex({
      id: "blog-id",
    });
    expect(err).toBe(backfillError);
    expect(changes).toBeUndefined();
  });

  it("returns errors from the initial redis query", async function () {
    var redisError = new Error("redis exploded");

    spyOn(client, "zCard").and.returnValues(
      Promise.reject(redisError),
      Promise.resolve("2")
    );
    spyOn(pathIndex, "backfillIndex");

    const { err, report: changes } = await settle_fixEntriesPathIndex({
      id: "blog-id",
    });
    expect(err).toBe(redisError);
    expect(changes).toBeUndefined();
    expect(pathIndex.backfillIndex).not.toHaveBeenCalled();
  });
});
