describe("sync/fix/entry-ghosts", function () {
  var storage = require("storage/folder");
  var Entry = require("models/entry");
  var Entries = require("models/entries");
  var fixEntryGhosts = require("../entry-ghosts");
  // Resolves to { err, report } instead of rejecting, so a spec can
  // assert on either
  const settle_fixEntryGhosts = (...args) =>
    fixEntryGhosts(...args).then(
      (report) => ({ err: null, report }),
      (err) => ({ err, report: undefined })
    );

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

  it("does nothing when every entry resolves to its own path on disk", async function () {
    spyOn(Entries, "each").and.callFake(async function (blogID, iterator) {
      await iterator({ id: "/foo.txt", path: "/foo.txt" });
    });
    spyOn(storage, "stat").and.callFake(async function () {
      return fileStat();
    });
    spyOn(Entry, "set");
    spyOn(Entry, "drop");

    const { err, report } = await settle_fixEntryGhosts({ id: "blog-id" });
    expect(err).toBeNull();
    expect(report).toBeUndefined();
    expect(Entry.set).not.toHaveBeenCalled();
    expect(Entry.drop).not.toHaveBeenCalled();
  });

  it("skips deleted entries entirely", async function () {
    spyOn(Entries, "each").and.callFake(async function (blogID, iterator) {
      await iterator({ id: "/foo.txt", path: "/foo.txt", deleted: true });
    });
    spyOn(storage, "stat");
    spyOn(Entry, "set");
    spyOn(Entry, "drop");

    const { err, report } = await settle_fixEntryGhosts({ id: "blog-id" });
    expect(err).toBeNull();
    expect(report).toBeUndefined();
    expect(storage.stat).not.toHaveBeenCalled();
    expect(Entry.set).not.toHaveBeenCalled();
    expect(Entry.drop).not.toHaveBeenCalled();
  });

  it("corrects an entry's path when the file exists under a different case", async function () {
    var entry = { id: "/Foo.txt", path: "/Foo.txt" };

    spyOn(Entries, "each").and.callFake(async function (blogID, iterator) {
      await iterator(entry);
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

    const { err, report } = await settle_fixEntryGhosts({ id: "blog-id" });
    expect(err).toBeNull();
    expect(Entry.set).toHaveBeenCalled();
    expect(Entry.drop).not.toHaveBeenCalled();
    expect(report).toEqual([
      ["CASE", { oldPath: "/Foo.txt", path: "/foo.txt" }],
    ]);
  });

  it("drops an entry when no file exists on disk for it", async function () {
    var entry = { id: "/missing.txt", path: "/missing.txt" };

    spyOn(Entries, "each").and.callFake(async function (blogID, iterator) {
      await iterator(entry);
    });

    spyOn(storage, "stat").and.callFake(async function () {
      throw missingError();
    });

    spyOn(Entry, "set");
    spyOn(Entry, "drop").and.callFake(async function (blogID, id) {
      expect(blogID).toBe("blog-id");
      expect(id).toBe("/missing.txt");
    });

    const { err, report } = await settle_fixEntryGhosts({ id: "blog-id" });
    expect(err).toBeNull();
    expect(Entry.set).not.toHaveBeenCalled();
    expect(Entry.drop).toHaveBeenCalled();
    expect(report).toEqual([
      ["MISSING", { id: "/missing.txt", path: "/missing.txt" }],
    ]);
  });

  it("drops by id rather than the stale path when an entry's id has since changed", async function () {
    var entry = { id: "/renamed.txt", path: "/old-path.txt" };

    spyOn(Entries, "each").and.callFake(async function (blogID, iterator) {
      await iterator(entry);
    });

    spyOn(storage, "stat").and.callFake(async function () {
      throw missingError();
    });

    spyOn(Entry, "drop").and.callFake(async function (blogID, id) {
      expect(id).toBe("/renamed.txt");
    });

    const { err } = await settle_fixEntryGhosts({ id: "blog-id" });
    expect(err).toBeNull();
    expect(Entry.drop).toHaveBeenCalled();
  });

  it("treats a folder post as a ghost only when its '+' source folder is gone", async function () {
    var entry = {
      id: "/album",
      path: "/album",
      html: folderPostHTML("/Album +"),
    };

    spyOn(Entries, "each").and.callFake(async function (blogID, iterator) {
      await iterator(entry);
    });

    spyOn(storage, "stat").and.callFake(async function (blogID, path) {
      expect(path).toBe("/Album +");
      return { isDirectory: true, size: 0, modified: 1 };
    });

    spyOn(Entry, "drop");

    const { err, report } = await settle_fixEntryGhosts({ id: "blog-id" });
    expect(err).toBeNull();
    expect(report).toBeUndefined();
    expect(storage.stat.calls.count()).toBe(1);
    expect(Entry.drop).not.toHaveBeenCalled();
  });

  it("drops a folder post whose source folder no longer exists", async function () {
    var entry = {
      id: "/album",
      path: "/album",
      html: folderPostHTML("/Album +"),
    };

    spyOn(Entries, "each").and.callFake(async function (blogID, iterator) {
      await iterator(entry);
    });

    spyOn(storage, "stat").and.callFake(async function () {
      throw missingError();
    });

    spyOn(Entry, "drop").and.callFake(async function (blogID, id) {
      expect(id).toBe("/album");
    });

    const { err, report } = await settle_fixEntryGhosts({ id: "blog-id" });
    expect(err).toBeNull();
    expect(Entry.drop).toHaveBeenCalled();
    expect(report).toEqual([["MISSING", { id: "/album", path: "/album" }]]);
  });

  it("does not drop an entry when checking its file fails for another reason", async function () {
    var readError = Object.assign(new Error("EIO"), { code: "EIO" });

    spyOn(Entries, "each").and.callFake(async function (blogID, iterator) {
      await iterator({ id: "/foo.txt", path: "/foo.txt" });
    });
    spyOn(storage, "stat").and.callFake(async function () {
      throw readError;
    });
    spyOn(Entry, "set");
    spyOn(Entry, "drop");

    const { err, report } = await settle_fixEntryGhosts({ id: "blog-id" });
    expect(err).toBe(readError);
    expect(report).toBeUndefined();
    expect(Entry.set).not.toHaveBeenCalled();
    expect(Entry.drop).not.toHaveBeenCalled();
  });

  it("does not drop a folder post when checking its source folder fails for another reason", async function () {
    var readError = Object.assign(new Error("EIO"), { code: "EIO" });

    spyOn(Entries, "each").and.callFake(async function (blogID, iterator) {
      await iterator({
        id: "/album",
        path: "/album",
        html: folderPostHTML("/Album +"),
      });
    });
    spyOn(storage, "stat").and.callFake(async function () {
      throw readError;
    });
    spyOn(Entry, "drop");

    const { err } = await settle_fixEntryGhosts({ id: "blog-id" });
    expect(err).toBe(readError);
    expect(Entry.drop).not.toHaveBeenCalled();
  });

  it("keeps an entry whose file has become a symlink", async function () {
    spyOn(Entries, "each").and.callFake(async function (blogID, iterator) {
      await iterator({ id: "/foo.txt", path: "/foo.txt" });
    });
    spyOn(storage, "stat").and.callFake(async function () {
      throw Object.assign(new Error("Symbolic links are not supported"), {
        code: "ELOOP",
      });
    });
    spyOn(Entry, "set");
    spyOn(Entry, "drop");

    const { err, report } = await settle_fixEntryGhosts({ id: "blog-id" });
    expect(err).toBeNull();
    expect(report).toBeUndefined();
    expect(Entry.set).not.toHaveBeenCalled();
    expect(Entry.drop).not.toHaveBeenCalled();
  });

  it("propagates an error raised while iterating entries", async function () {
    var iterationError = new Error("redis exploded");

    spyOn(Entries, "each").and.callFake(async function () {
      throw iterationError;
    });
    spyOn(Entry, "set");
    spyOn(Entry, "drop");

    const { err, report } = await settle_fixEntryGhosts({ id: "blog-id" });
    expect(err).toBe(iterationError);
    expect(report).toBeUndefined();
    expect(Entry.set).not.toHaveBeenCalled();
    expect(Entry.drop).not.toHaveBeenCalled();
  });

  it("propagates an error from Entry.drop without dropping remaining ghosts", async function () {
    var dropError = new Error("drop exploded");
    var entries = [
      { id: "/a.txt", path: "/a.txt" },
      { id: "/b.txt", path: "/b.txt" },
    ];

    spyOn(Entries, "each").and.callFake(async function (blogID, iterator) {
      for (var entry of entries) await iterator(entry);
    });

    spyOn(storage, "stat").and.callFake(async function () {
      throw missingError();
    });

    var dropCalls = 0;
    spyOn(Entry, "drop").and.callFake(async function (blogID, id) {
      dropCalls++;
      throw dropError;
    });

    const { err } = await settle_fixEntryGhosts({ id: "blog-id" });
    expect(err).toBe(dropError);
    expect(dropCalls).toBe(1);
  });
});
