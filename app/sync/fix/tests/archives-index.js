describe("sync/fix/archives-index", function () {
  var client = require("models/client");
  var Archives = require("models/archives");
  var fixArchivesIndex = require("../archives-index");

  it("does nothing when the index is ready and counts match", function (done) {
    spyOn(client, "zCard").and.returnValue(Promise.resolve("2"));
    spyOn(Archives, "isReady").and.returnValue(Promise.resolve(true));
    spyOn(Archives, "months").and.returnValue(
      Promise.resolve([{ yearMonth: "2020-01", count: 2 }])
    );
    spyOn(Archives, "rebuild");

    fixArchivesIndex({ id: "blog-id" }, function (err, changes) {
      expect(err).toBeNull();
      expect(changes).toEqual([]);
      expect(Archives.rebuild).not.toHaveBeenCalled();
      done();
    });
  });

  it("rebuilds when the index has never been built", function (done) {
    spyOn(client, "zCard").and.returnValue(Promise.resolve("3"));
    spyOn(Archives, "isReady").and.returnValue(Promise.resolve(false));
    spyOn(Archives, "rebuild").and.callFake(function (blogID, callback) {
      expect(blogID).toBe("blog-id");
      callback(null, 3);
    });

    fixArchivesIndex({ id: "blog-id" }, function (err, changes) {
      expect(err).toBeNull();
      expect(changes).toEqual([
        ["MISMATCH", { entries: 3, archives: 0 }],
        ["BACKFILLED", 3],
      ]);
      done();
    });
  });

  it("rebuilds when the ready index's entry count has drifted", function (done) {
    spyOn(client, "zCard").and.returnValue(Promise.resolve("5"));
    spyOn(Archives, "isReady").and.returnValue(Promise.resolve(true));
    spyOn(Archives, "months").and.returnValue(
      Promise.resolve([{ yearMonth: "2020-01", count: 3 }])
    );
    spyOn(Archives, "rebuild").and.callFake(function (blogID, callback) {
      callback(null, 5);
    });

    fixArchivesIndex({ id: "blog-id" }, function (err, changes) {
      expect(err).toBeNull();
      expect(changes).toEqual([
        ["MISMATCH", { entries: 5, archives: 3 }],
        ["BACKFILLED", 5],
      ]);
      done();
    });
  });

  it("returns errors from rebuild", function (done) {
    var rebuildError = new Error("rebuild exploded");

    spyOn(client, "zCard").and.returnValue(Promise.resolve("3"));
    spyOn(Archives, "isReady").and.returnValue(Promise.resolve(false));
    spyOn(Archives, "rebuild").and.callFake(function (blogID, callback) {
      callback(rebuildError);
    });

    fixArchivesIndex({ id: "blog-id" }, function (err, changes) {
      expect(err).toBe(rebuildError);
      expect(changes).toBeUndefined();
      done();
    });
  });
});
