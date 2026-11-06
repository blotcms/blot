describe("sync/fix/entries-path-index", function () {
  var client = require("models/client");
  var pathIndex = require("models/entries/pathIndex");
  var fixEntriesPathIndex = require("../entries-path-index");

  it("does nothing when entry count and path index count match", function (done) {
    var zcard = spyOn(client, "zCard").and.returnValues(
      Promise.resolve("2"),
      Promise.resolve("2")
    );
    spyOn(pathIndex, "backfillIndex");

    fixEntriesPathIndex({ id: "blog-id" }, function (err, changes) {
      expect(err).toBeNull();
      expect(changes).toEqual([]);
      expect(zcard.calls.count()).toBe(2);
      expect(pathIndex.backfillIndex).not.toHaveBeenCalled();
      done();
    });
  });

  it("backfills the index when counts do not match", function (done) {
    spyOn(client, "zCard").and.returnValues(
      Promise.resolve("5"),
      Promise.resolve("3")
    );
    spyOn(pathIndex, "backfillIndex").and.callFake(function (blogID, callback) {
      expect(blogID).toBe("blog-id");
      callback(null, 5);
    });

    fixEntriesPathIndex({ id: "blog-id" }, function (err, changes) {
      expect(err).toBeNull();
      expect(changes).toEqual([
        ["MISMATCH", { entries: 5, pathIndex: 3 }],
        ["BACKFILLED", 5],
      ]);
      expect(pathIndex.backfillIndex).toHaveBeenCalled();
      done();
    });
  });

  it("returns errors from backfill when counts do not match", function (done) {
    var backfillError = new Error("backfill exploded");

    spyOn(client, "zCard").and.returnValues(
      Promise.resolve("5"),
      Promise.resolve("3")
    );
    spyOn(pathIndex, "backfillIndex").and.callFake(
      function (_blogID, callback) {
        callback(backfillError);
      }
    );

    fixEntriesPathIndex({ id: "blog-id" }, function (err, changes) {
      expect(err).toBe(backfillError);
      expect(changes).toBeUndefined();
      done();
    });
  });

  it("returns errors from the initial redis query", function (done) {
    var redisError = new Error("redis exploded");

    spyOn(client, "zCard").and.returnValues(
      Promise.reject(redisError),
      Promise.resolve("2")
    );
    spyOn(pathIndex, "backfillIndex");

    fixEntriesPathIndex({ id: "blog-id" }, function (err, changes) {
      expect(err).toBe(redisError);
      expect(changes).toBeUndefined();
      expect(pathIndex.backfillIndex).not.toHaveBeenCalled();
      done();
    });
  });
});
