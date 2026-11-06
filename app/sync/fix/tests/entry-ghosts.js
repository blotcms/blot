describe("sync/fix/entry-ghosts", function () {
  var storage = require("storage/folder");
  var Entry = require("models/entry");
  var Entries = require("models/entries");
  var fixEntryGhosts = require("../entry-ghosts");

  function missingError() {
    return new storage.NotFoundError();
  }

  function fileStat() {
    return { isDirectory: false, size: 1, modified: 1 };
  }

  function folderPostHTML(folder) {
    return (
      '<section class="multi-file-post" data-folder="' +
      folder +
      '">' +
      "</section>"
    );
  }

  it("does nothing when every entry resolves to its own path on disk", function (done) {
    spyOn(Entries, "each").and.callFake(function (blogID, iterator, callback) {
      iterator({ id: "/foo.txt", path: "/foo.txt" }, function () {
        callback();
      });
    });
    spyOn(storage, "stat").and.callFake(async function () {
      return fileStat();
    });
    spyOn(Entry, "set");
    spyOn(Entry, "drop");

    fixEntryGhosts({ id: "blog-id" }, function (err, report) {
      expect(err).toBeNull();
      expect(report).toBeUndefined();
      expect(Entry.set).not.toHaveBeenCalled();
      expect(Entry.drop).not.toHaveBeenCalled();
      done();
    });
  });

  it("skips deleted entries entirely", function (done) {
    spyOn(Entries, "each").and.callFake(function (blogID, iterator, callback) {
      iterator(
        { id: "/foo.txt", path: "/foo.txt", deleted: true },
        function () {
          callback();
        }
      );
    });
    spyOn(storage, "stat");
    spyOn(Entry, "set");
    spyOn(Entry, "drop");

    fixEntryGhosts({ id: "blog-id" }, function (err, report) {
      expect(err).toBeNull();
      expect(report).toBeUndefined();
      expect(storage.stat).not.toHaveBeenCalled();
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

    spyOn(storage, "stat").and.callFake(async function (blogID, path) {
      // only the lowercased candidate exists on disk
      if (path.toLowerCase() === path) return fileStat();
      throw missingError();
    });

    spyOn(Entry, "set").and.callFake(async function (blogID, path, updates) {
      expect(blogID).toBe("blog-id");
      expect(path).toBe("/Foo.txt");
      expect(updates).toEqual({ path: "/foo.txt" });
    });
    spyOn(Entry, "drop");

    fixEntryGhosts({ id: "blog-id" }, function (err, report) {
      expect(err).toBeNull();
      expect(Entry.set).toHaveBeenCalled();
      expect(Entry.drop).not.toHaveBeenCalled();
      expect(report).toEqual([
        ["CASE", { oldPath: "/Foo.txt", path: "/foo.txt" }],
      ]);
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

    spyOn(storage, "stat").and.callFake(async function () {
      throw missingError();
    });

    spyOn(Entry, "set");
    spyOn(Entry, "drop").and.callFake(async function (blogID, id) {
      expect(blogID).toBe("blog-id");
      expect(id).toBe("/missing.txt");
    });

    fixEntryGhosts({ id: "blog-id" }, function (err, report) {
      expect(err).toBeNull();
      expect(Entry.set).not.toHaveBeenCalled();
      expect(Entry.drop).toHaveBeenCalled();
      expect(report).toEqual([
        ["MISSING", { id: "/missing.txt", path: "/missing.txt" }],
      ]);
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

    spyOn(storage, "stat").and.callFake(async function () {
      throw missingError();
    });

    spyOn(Entry, "drop").and.callFake(async function (blogID, id) {
      expect(id).toBe("/renamed.txt");
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

    spyOn(storage, "stat").and.callFake(async function (blogID, path) {
      expect(path).toBe("/Album +");
      return { isDirectory: true, size: 0, modified: 1 };
    });

    spyOn(Entry, "drop");

    fixEntryGhosts({ id: "blog-id" }, function (err, report) {
      expect(err).toBeNull();
      expect(report).toBeUndefined();
      expect(storage.stat.calls.count()).toBe(1);
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

    spyOn(storage, "stat").and.callFake(async function () {
      throw missingError();
    });

    spyOn(Entry, "drop").and.callFake(async function (blogID, id) {
      expect(id).toBe("/album");
    });

    fixEntryGhosts({ id: "blog-id" }, function (err, report) {
      expect(err).toBeNull();
      expect(Entry.drop).toHaveBeenCalled();
      expect(report).toEqual([["MISSING", { id: "/album", path: "/album" }]]);
      done();
    });
  });

  it("does not drop an entry when checking its file fails for another reason", function (done) {
    var readError = Object.assign(new Error("EIO"), { code: "EIO" });

    spyOn(Entries, "each").and.callFake(function (blogID, iterator, callback) {
      iterator({ id: "/foo.txt", path: "/foo.txt" }, function (err) {
        callback(err);
      });
    });
    spyOn(storage, "stat").and.callFake(async function () {
      throw readError;
    });
    spyOn(Entry, "set");
    spyOn(Entry, "drop");

    fixEntryGhosts({ id: "blog-id" }, function (err, report) {
      expect(err).toBe(readError);
      expect(report).toBeUndefined();
      expect(Entry.set).not.toHaveBeenCalled();
      expect(Entry.drop).not.toHaveBeenCalled();
      done();
    });
  });

  it("does not drop a folder post when checking its source folder fails for another reason", function (done) {
    var readError = Object.assign(new Error("EIO"), { code: "EIO" });

    spyOn(Entries, "each").and.callFake(function (blogID, iterator, callback) {
      iterator(
        { id: "/album", path: "/album", html: folderPostHTML("/Album +") },
        function (err) {
          callback(err);
        }
      );
    });
    spyOn(storage, "stat").and.callFake(async function () {
      throw readError;
    });
    spyOn(Entry, "drop");

    fixEntryGhosts({ id: "blog-id" }, function (err) {
      expect(err).toBe(readError);
      expect(Entry.drop).not.toHaveBeenCalled();
      done();
    });
  });

  it("keeps an entry whose file has become a symlink", function (done) {
    spyOn(Entries, "each").and.callFake(function (blogID, iterator, callback) {
      iterator({ id: "/foo.txt", path: "/foo.txt" }, function (err) {
        callback(err);
      });
    });
    spyOn(storage, "stat").and.callFake(async function () {
      throw Object.assign(new Error("Symbolic links are not supported"), {
        code: "ELOOP",
      });
    });
    spyOn(Entry, "set");
    spyOn(Entry, "drop");

    fixEntryGhosts({ id: "blog-id" }, function (err, report) {
      expect(err).toBeNull();
      expect(report).toBeUndefined();
      expect(Entry.set).not.toHaveBeenCalled();
      expect(Entry.drop).not.toHaveBeenCalled();
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

    spyOn(storage, "stat").and.callFake(async function () {
      throw missingError();
    });

    var dropCalls = 0;
    spyOn(Entry, "drop").and.callFake(async function (blogID, id) {
      dropCalls++;
      throw dropError;
    });

    fixEntryGhosts({ id: "blog-id" }, function (err) {
      expect(err).toBe(dropError);
      expect(dropCalls).toBe(1);
      done();
    });
  });
});
