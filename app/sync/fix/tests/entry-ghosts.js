describe("sync/fix/entry-ghosts", function () {
  var fs = require("fs");
  var Entry = require("models/entry");
  var Entries = require("models/entries");
  var fixEntryGhosts = require("../entry-ghosts");

  function folderPostHTML(folder) {
    return (
      '<section class="multi-file-post" data-folder="' + folder + '">' +
      "</section>"
    );
  }

  it("does nothing when every entry resolves to its own path on disk", function (done) {
    spyOn(Entries, "each").and.callFake(function (blogID, iterator, callback) {
      iterator({ id: "/foo.txt", path: "/foo.txt" }, function () {
        callback();
      });
    });
    spyOn(fs, "access").and.callFake(function (path, callback) {
      callback(null);
    });
    spyOn(Entry, "set");
    spyOn(Entry, "drop");

    fixEntryGhosts({ id: "blog-id" }, function (err, report) {
      expect(err).toBeUndefined();
      expect(report).toBeUndefined();
      expect(Entry.set).not.toHaveBeenCalled();
      expect(Entry.drop).not.toHaveBeenCalled();
      done();
    });
  });

  it("skips deleted entries entirely", function (done) {
    spyOn(Entries, "each").and.callFake(function (blogID, iterator, callback) {
      iterator({ id: "/foo.txt", path: "/foo.txt", deleted: true }, function () {
        callback();
      });
    });
    spyOn(fs, "access");
    spyOn(Entry, "set");
    spyOn(Entry, "drop");

    fixEntryGhosts({ id: "blog-id" }, function (err, report) {
      expect(err).toBeUndefined();
      expect(report).toBeUndefined();
      expect(fs.access).not.toHaveBeenCalled();
      expect(Entry.set).not.toHaveBeenCalled();
      expect(Entry.drop).not.toHaveBeenCalled();
      done();
    });
  });

  it("corrects an entry's path when the file exists under a different case", function (done) {
    var entry = { id: "/Foo.txt", path: "/Foo.txt" };

    spyOn(Entries, "each").and.callFake(function (blogID, iterator, callback) {
      iterator(entry, function () {
        callback();
      });
    });

    spyOn(fs, "access").and.callFake(function (path, callback) {
      // only the lowercased candidate exists on disk
      if (path.toLowerCase() === path) return callback(null);
      callback(new Error("ENOENT"));
    });

    spyOn(Entry, "set").and.callFake(function (blogID, path, updates, callback) {
      expect(blogID).toBe("blog-id");
      expect(path).toBe("/Foo.txt");
      expect(updates).toEqual({ path: "/foo.txt" });
      callback();
    });
    spyOn(Entry, "drop");

    fixEntryGhosts({ id: "blog-id" }, function (err, report) {
      expect(err).toBeNull();
      expect(Entry.set).toHaveBeenCalled();
      expect(Entry.drop).not.toHaveBeenCalled();
      expect(report).toEqual(
        jasmine.arrayContaining([jasmine.stringMatching(/different case/)])
      );
      done();
    });
  });

  it("drops an entry when no file exists on disk for it", function (done) {
    var entry = { id: "/missing.txt", path: "/missing.txt" };

    spyOn(Entries, "each").and.callFake(function (blogID, iterator, callback) {
      iterator(entry, function () {
        callback();
      });
    });

    spyOn(fs, "access").and.callFake(function (path, callback) {
      callback(new Error("ENOENT"));
    });

    spyOn(Entry, "set");
    spyOn(Entry, "drop").and.callFake(function (blogID, id, callback) {
      expect(blogID).toBe("blog-id");
      expect(id).toBe("/missing.txt");
      callback();
    });

    fixEntryGhosts({ id: "blog-id" }, function (err, report) {
      expect(err).toBeNull();
      expect(Entry.set).not.toHaveBeenCalled();
      expect(Entry.drop).toHaveBeenCalled();
      expect(report).toEqual(
        jasmine.arrayContaining([
          jasmine.stringMatching(/missing from the disk/),
        ])
      );
      done();
    });
  });

  it("drops by id rather than the stale path when an entry's id has since changed", function (done) {
    var entry = { id: "/renamed.txt", path: "/old-path.txt" };

    spyOn(Entries, "each").and.callFake(function (blogID, iterator, callback) {
      iterator(entry, function () {
        callback();
      });
    });

    spyOn(fs, "access").and.callFake(function (path, callback) {
      callback(new Error("ENOENT"));
    });

    spyOn(Entry, "drop").and.callFake(function (blogID, id, callback) {
      expect(id).toBe("/renamed.txt");
      callback();
    });

    fixEntryGhosts({ id: "blog-id" }, function (err) {
      expect(err).toBeNull();
      expect(Entry.drop).toHaveBeenCalled();
      done();
    });
  });

  it("treats a folder post as a ghost only when its '+' source folder is gone", function (done) {
    var entry = {
      id: "/album",
      path: "/album",
      html: folderPostHTML("/Album +"),
    };

    spyOn(Entries, "each").and.callFake(function (blogID, iterator, callback) {
      iterator(entry, function () {
        callback();
      });
    });

    spyOn(fs, "access");
    spyOn(fs, "stat").and.callFake(function (path, callback) {
      expect(path.endsWith("Album +")).toBe(true);
      callback(null, { isDirectory: function () { return true; } });
    });

    spyOn(Entry, "drop");

    fixEntryGhosts({ id: "blog-id" }, function (err, report) {
      expect(err).toBeUndefined();
      expect(report).toBeUndefined();
      expect(fs.access).not.toHaveBeenCalled();
      expect(Entry.drop).not.toHaveBeenCalled();
      done();
    });
  });

  it("drops a folder post whose source folder no longer exists", function (done) {
    var entry = {
      id: "/album",
      path: "/album",
      html: folderPostHTML("/Album +"),
    };

    spyOn(Entries, "each").and.callFake(function (blogID, iterator, callback) {
      iterator(entry, function () {
        callback();
      });
    });

    spyOn(fs, "stat").and.callFake(function (path, callback) {
      callback(new Error("ENOENT"));
    });

    spyOn(Entry, "drop").and.callFake(function (blogID, id, callback) {
      expect(id).toBe("/album");
      callback();
    });

    fixEntryGhosts({ id: "blog-id" }, function (err, report) {
      expect(err).toBeNull();
      expect(Entry.drop).toHaveBeenCalled();
      expect(report).toEqual(
        jasmine.arrayContaining([
          jasmine.stringMatching(/missing from the disk/),
        ])
      );
      done();
    });
  });

  it("propagates an error raised while iterating entries", function (done) {
    var iterationError = new Error("redis exploded");

    spyOn(Entries, "each").and.callFake(function (blogID, iterator, callback) {
      callback(iterationError);
    });
    spyOn(Entry, "set");
    spyOn(Entry, "drop");

    fixEntryGhosts({ id: "blog-id" }, function (err, report) {
      expect(err).toBe(iterationError);
      expect(report).toBeUndefined();
      expect(Entry.set).not.toHaveBeenCalled();
      expect(Entry.drop).not.toHaveBeenCalled();
      done();
    });
  });

  it("propagates an error from Entry.drop without dropping remaining ghosts", function (done) {
    var dropError = new Error("drop exploded");
    var entries = [
      { id: "/a.txt", path: "/a.txt" },
      { id: "/b.txt", path: "/b.txt" },
    ];

    spyOn(Entries, "each").and.callFake(function (blogID, iterator, callback) {
      var i = 0;
      (function next() {
        if (i >= entries.length) return callback();
        iterator(entries[i++], next);
      })();
    });

    spyOn(fs, "access").and.callFake(function (path, callback) {
      callback(new Error("ENOENT"));
    });

    var dropCalls = 0;
    spyOn(Entry, "drop").and.callFake(function (blogID, id, callback) {
      dropCalls++;
      callback(dropError);
    });

    fixEntryGhosts({ id: "blog-id" }, function (err) {
      expect(err).toBe(dropError);
      expect(dropCalls).toBe(1);
      done();
    });
  });
});
