// Fix() runs entry-ghosts before tag-ghosts and list-ghosts, and shares one
// entry-cache instance across all three (see fix/index.js). entry-ghosts can
// mutate an entry (Entry.set / Entry.drop) before the later checks run, so
// this proves the cache is invalidated correctly for a mutated id instead
// of leaving those later checks acting on what entry-ghosts saw during its
// own scan.
describe("sync/fix entry-cache sharing across checks", function () {
  var fs = require("fs");
  var Entry = require("models/entry");
  var Entries = require("models/entries");
  var Tags = require("models/tags");
  var client = require("models/client");
  var entryKey = require("models/entry/key").entry;
  var createEntryCache = require("../entry-cache");
  var fixEntryGhosts = require("../entry-ghosts");
  var fixTagGhosts = require("../tag-ghosts");

  it("has tag-ghosts see a drop entry-ghosts just made, instead of the stale cached entry", function (done) {
    var cache = createEntryCache("blog-id");
    var entry = { id: "/gone.txt", path: "/gone.txt" };

    // entry-ghosts scans the entry, finds no file for it on disk, and
    // drops it.
    spyOn(Entries, "each").and.callFake(function (blogID, iterator, callback) {
      iterator(entry, function () {
        callback();
      });
    });
    spyOn(fs, "access").and.callFake(function (path, callback) {
      callback(new Error("ENOENT"));
    });
    spyOn(Entry, "drop").and.callFake(function (blogID, id, callback) {
      callback();
    });

    fixEntryGhosts({ id: "blog-id" }, cache, function (err) {
      expect(err).toBeNull();
      // entry-ghosts populated the cache from its scan, then invalidated
      // it again once the drop was applied.
      expect(cache.has("/gone.txt")).toBe(false);

      // tag-ghosts runs next in the same Fix() call, still referencing the
      // dropped entry from a tag that hasn't been cleaned up yet.
      spyOn(Tags, "list").and.callFake(function (_blogID, callback) {
        callback(null, [{ slug: "stuff" }]);
      });
      spyOn(Tags, "get").and.callFake(function (_blogID, slug, callback) {
        callback(null, ["/gone.txt"]);
      });
      // Because the cache was invalidated, tag-ghosts has to go back to
      // Redis for this id - and finds it genuinely gone.
      spyOn(client, "mGet").and.callFake(function (keys) {
        expect(keys).toEqual([entryKey("blog-id", "/gone.txt")]);
        return Promise.resolve([null]);
      });

      var multi = {
        zRem: jasmine.createSpy("zRem"),
        exec: jasmine.createSpy("exec").and.callFake(function (callback) {
          callback(null);
        }),
      };
      spyOn(client, "multi").and.returnValue(multi);

      fixTagGhosts({ id: "blog-id" }, cache, function (err, report) {
        expect(err).toBeNull();
        expect(report).toEqual([["MISSING", "/gone.txt"]]);
        expect(client.mGet).toHaveBeenCalled();
        done();
      });
    });
  });
});
