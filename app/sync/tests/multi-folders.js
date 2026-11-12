describe("sync multi-folder support", function () {
  var storage = require("storage/folder");
  var path = require("path");
  var Entry = require("models/entry");
  var Entries = require("models/entries");
  var syncFolder = require("sync");

  var drafts = require("../update/drafts");
  var previewPath = drafts.previewPath;

  global.test.blog();

  global.test.timeout(60 * 1000); // 60s

  beforeEach(function () {
    this.fake = global.test.fake;
    this.checkEntry = global.test.CheckEntry(this.blog.id);
    this.syncAndCheck = global.test.SyncAndCheck(this.blog.id);
  });

  it("builds an aggregated entry and drops child entries", function (done) {
    this.syncAndCheck(
      [
        { path: "/album+/one.md", content: "# One" },
        { path: "/album+/two.md", content: "# Two" },
      ],
      [
        {
          path: "/album",
          html: function (html) {
            return html.indexOf("One") > -1 && html.indexOf("Two") > -1;
          },
          metadata: function (metadata) {
            return !metadata._sourcePaths;
          },
        },
        { path: "/album+/one.md", ignored: true },
        { path: "/album+/two.md", ignored: true },
      ],
      done
    );
  });

  it("aggregates nested multi-folder files in alphabetical order", function (done) {
    this.syncAndCheck(
      [
        { path: "/album+/1.md", content: "# One" },
        { path: "/album+/2/a.md", content: "# Two A" },
        { path: "/album+/2/b.md", content: "# Two B" },
        { path: "/album+/3.md", content: "# Three" },
      ],
      [
        {
          path: "/album",
          html: function (html) {
            var order = [
              'data-file="/album+/1.md"',
              'data-file="/album+/2/a.md"',
              'data-file="/album+/2/b.md"',
              'data-file="/album+/3.md"',
            ];

            var lastIndex = -1;

            return order.every(function (token) {
              var index = html.indexOf(token);
              if (index === -1 || index < lastIndex) return false;
              lastIndex = index;
              return true;
            });
          },
          metadata: function (metadata) {
            return !metadata._sourcePaths;
          },
        },
        { path: "/album+/1.md", ignored: true },
        { path: "/album+/2/a.md", ignored: true },
        { path: "/album+/2/b.md", ignored: true },
        { path: "/album+/3.md", ignored: true },
      ],
      done
    );
  });

  it("ignores hidden files inside multi-folders", function (done) {
    this.syncAndCheck(
      [
        { path: "/album+/one.md", content: "# One" },
        { path: "/album+/_two.md", content: "# Two" },
        { path: "/album+/_hidden/three.md", content: "# Three" },
      ],
      [
        {
          path: "/album",
          html: function (html) {
            return (
              html.indexOf("One") > -1 &&
              html.indexOf("Two") === -1 &&
              html.indexOf("Three") === -1
            );
          },
        },
        { path: "/album+/one.md", ignored: true },
        { path: "/album+/_two.md", ignored: true },
        { path: "/album+/_hidden/three.md", ignored: true },
      ],
      done
    );
  });

  it("builds a folder post when the folder name contains brackets", function (done) {
    this.syncAndCheck(
      [{ path: "/[Blog]+/one.md", content: "# Hello from brackets" }],
      [
        {
          path: "/[Blog]",
          html: function (html) {
            return (
              html.indexOf("Hello from brackets") > -1 &&
              html.indexOf('data-folder="/[Blog]+"') > -1
            );
          },
          metadata: function (metadata) {
            return !metadata._sourcePaths;
          },
        },
        { path: "/[Blog]+/one.md", ignored: true },
      ],
      done
    );
  });

  it("skips multi-folder aggregation when more than 50 files exist", async function () {
    for (var i = 1; i <= 51; i++) {
      var name = i < 10 ? "0" + i : String(i);
      await this.blog.write({
        path: "/album+/" + name + ".md",
        content: "# File " + name,
      });
    }

    await this.blog.rebuild();

    try {
      await this.blog.check({ path: "/album" });
      throw new Error("Multi-folder post built incorrectly");
    } catch (e) {
      expect(e.message).toContain("No entry exists");
    }

    try {
      await this.blog.check({ path: "/album+/01.md" });
      throw new Error("Multi-folder post built incorrectly");
    } catch (e) {
      expect(e.message).toContain("No entry exists");
    }
  });

  it("builds a multi-folder post from exactly 50 files", async function () {
    for (var i = 1; i <= 50; i++) {
      var name = i < 10 ? "0" + i : String(i);
      await this.blog.write({
        path: "/album+/" + name + ".md",
        content: "# File " + name,
      });
    }

    await this.blog.rebuild();

    await this.blog.check({
      path: "/album",
      html: function (html) {
        return (
          html.indexOf('data-file="/album+/01.md"') > -1 &&
          html.indexOf('data-file="/album+/50.md"') > -1
        );
      },
    });
  });

  it("writes previews for aggregated draft entries", function (done) {
    this.syncAndCheck(
      { path: "/drafts/post+/index.md", content: "# Draft" },
      {
        path: "/drafts/post",
        draft: true,
        metadata: function (metadata) {
          return !metadata._sourcePaths;
        },
      },
      (err) => {
        if (err) return done.fail(err);

        var blogID = this.blog.id;
        var previewFile = previewPath("/drafts/post");

        Promise.all([
          storage.exists(blogID, previewFile),
          storage.listNames(blogID, path.posix.dirname(previewFile)),
        ]).then(function (results) {
          expect(results[0]).toBe(true);
          expect(
            results[1].filter(function (entry) {
              return entry.name.indexOf(".tmp-") === 0;
            })
          ).toEqual([]);
          done();
        }, done.fail);
      }
    );
  });

  // Writes each [path, contents] pair and syncs it, in order, in one sync
  function writeAndSync(blogID, files) {
    return syncFolder(blogID, async function (folder) {
      for (const [path, contents] of files) {
        await storage.write(blogID, path, contents);
        await folder.update(path);
      }
    });
  }

  // Syncs each path, in order, in one sync
  function syncPaths(blogID, paths) {
    return syncFolder(blogID, async function (folder) {
      for (const path of paths) await folder.update(path);
    });
  }

  it("handles renaming a directory to use the + convention", async function () {
    var blogID = this.blog.id;

    await writeAndSync(blogID, [["/images/photo.md", "# Photo"]]);

    var initialEntry = await Entry.get(blogID, "/images/photo.md");
    expect(initialEntry).toBeDefined();

    await storage.move(blogID, "/images", "/images+");
    await syncPaths(blogID, [
      "/images/photo.md",
      "/images+/photo.md",
      "/images+",
    ]);

    var aggregatedEntry = await Entry.get(blogID, "/images");
    expect(aggregatedEntry).toBeDefined();
    expect(aggregatedEntry.deleted).toBeFalsy();
    expect(aggregatedEntry.path).toEqual("/images");
    expect(aggregatedEntry.metadata._sourcePaths).toBeUndefined();

    var oldEntry = await Entry.get(blogID, "/images/photo.md");
    if (oldEntry) {
      expect(oldEntry.deleted).toBe(true);
    }
  });

  it("rebuilds the aggregated entry when a child file is removed", async function () {
    var blogID = this.blog.id;

    await writeAndSync(blogID, [
      ["/album+/one.md", "# One"],
      ["/album+/two.md", "# Two"],
    ]);

    var initialEntry = await Entry.get(blogID, "/album");
    expect(initialEntry).toBeDefined();
    expect(initialEntry.html.indexOf("One")).toBeGreaterThan(-1);
    expect(initialEntry.html.indexOf("Two")).toBeGreaterThan(-1);

    await storage.remove(blogID, "/album+/two.md");
    await syncPaths(blogID, ["/album+/two.md"]);

    var rebuiltEntry = await Entry.get(blogID, "/album");
    expect(rebuiltEntry).toBeDefined();
    expect(rebuiltEntry.deleted).toBeFalsy();
    expect(rebuiltEntry.html.indexOf("One")).toBeGreaterThan(-1);
    expect(rebuiltEntry.html.indexOf("Two")).toBe(-1);
  });

  it("drops the synthesized entry when the + folder is removed", async function () {
    var blogID = this.blog.id;

    await writeAndSync(blogID, [
      ["/gallery+/a.md", "# A"],
      ["/gallery+/b.md", "# B"],
    ]);

    var initialEntry = await Entry.get(blogID, "/gallery");
    expect(initialEntry).toBeDefined();
    expect(initialEntry.deleted).toBeFalsy();

    await storage.remove(blogID, "/gallery+");
    await syncPaths(blogID, ["/gallery+/a.md", "/gallery+/b.md", "/gallery+"]);

    var droppedEntry = await Entry.get(blogID, "/gallery");
    if (droppedEntry) {
      expect(droppedEntry.deleted).toBe(true);
    } else {
      expect(droppedEntry).toBeFalsy();
    }
  });

  it("keeps the aggregate entry when Fix runs on server restart", async function () {
    var Fix = require("sync/fix");
    var blog = this.blog;
    var blogID = blog.id;

    await writeAndSync(blogID, [
      ["/essay+/one.md", "# One"],
      ["/essay+/two.md", "# Two"],
    ]);

    var initialEntry = await Entry.get(blogID, "/essay");
    expect(initialEntry).toBeDefined();
    expect(initialEntry.deleted).toBeFalsy();

    // Fix() runs on every client startup / server restart. The
    // folder post's aggregate lives at a "+"-stripped path with no
    // file behind it, so entry-ghosts must not treat it as a ghost.
    await Fix(blog);

    var afterEntry = await Entry.get(blogID, "/essay");
    expect(afterEntry).toBeDefined();
    expect(afterEntry.deleted).toBeFalsy();
    expect(afterEntry.html.indexOf("One")).toBeGreaterThan(-1);
    expect(afterEntry.html.indexOf("Two")).toBeGreaterThan(-1);
  });

  it("drops the aggregate through Fix when the + folder is gone", async function () {
    var Fix = require("sync/fix");
    var blog = this.blog;
    var blogID = blog.id;

    await writeAndSync(blogID, [
      ["/essay+/one.md", "# One"],
      ["/essay+/two.md", "# Two"],
    ]);

    var initialEntry = await Entry.get(blogID, "/essay");
    expect(initialEntry).toBeDefined();
    expect(initialEntry.deleted).toBeFalsy();

    // Remove the folder without letting sync see it, then let Fix
    // reconcile: the aggregate has no source folder left on disk, so
    // it is a genuine ghost and must be dropped.
    await storage.remove(blogID, "/essay+");
    await Fix(blog);

    var afterEntry = await Entry.get(blogID, "/essay");
    if (afterEntry) {
      expect(afterEntry.deleted).toBe(true);
    } else {
      expect(afterEntry).toBeFalsy();
    }
  });

  it("drops the aggregate when the + folder is replaced by a file", async function () {
    var Fix = require("sync/fix");
    var blog = this.blog;
    var blogID = blog.id;

    await writeAndSync(blogID, [
      ["/essay+/one.md", "# One"],
      ["/essay+/two.md", "# Two"],
    ]);

    var initialEntry = await Entry.get(blogID, "/essay");
    expect(initialEntry).toBeDefined();

    // Swap the directory for a plain file at the same path.
    await storage.remove(blogID, "/essay+");
    await storage.write(blogID, "/essay+", "not a folder");
    await syncPaths(blogID, ["/essay+"]);

    var afterUpdate = await Entry.get(blogID, "/essay");
    if (afterUpdate) {
      expect(afterUpdate.deleted).toBe(true);
    } else {
      expect(afterUpdate).toBeFalsy();
    }

    // Fix() also treats a non-directory "+" path as a ghost.
    await Fix(blog);

    var afterFix = await Entry.get(blogID, "/essay");
    if (afterFix) {
      expect(afterFix.deleted).toBe(true);
    } else {
      expect(afterFix).toBeFalsy();
    }
  });

  it("keeps a sibling post when a plain +-suffixed file shares its stripped path", async function () {
    var blogID = this.blog.id;

    await writeAndSync(blogID, [
      ["/post.md", "# The Real Post"],
      // A file that just happens to end in "+", never a folder.
      ["/post.md+", "leftover"],
    ]);

    var entry = await Entry.get(blogID, "/post.md");
    expect(entry).toBeDefined();
    expect(entry.deleted).toBeFalsy();
    expect(entry.html.indexOf("The Real Post")).toBeGreaterThan(-1);
  });

  it("keeps a sibling file's entry when a + folder collides with its stripped path", async function () {
    var blogID = this.blog.id;

    await writeAndSync(blogID, [
      ["/article.md", "# The Real Article"],
      ["/article.md+/extra.md", "# Extra"],
    ]);

    var entry = await Entry.get(blogID, "/article.md");
    expect(entry).toBeDefined();
    expect(entry.deleted).toBeFalsy();
    expect(entry.html.indexOf("The Real Article")).toBeGreaterThan(-1);
    expect(entry.html.indexOf("multi-file-post")).toBe(-1);
  });

  it("drops the aggregate when every file is removed and only the files are synced", async function () {
    var blogID = this.blog.id;

    await writeAndSync(blogID, [
      ["/notes/multi+/a.md", "# A"],
      ["/notes/multi+/b.md", "# B"],
    ]);

    var initialEntry = await Entry.get(blogID, "/notes/multi");
    expect(initialEntry).toBeDefined();
    expect(initialEntry.deleted).toBeFalsy();

    // Like a push to a repository: the files and the folder are
    // gone, and only the file paths are reported.
    await storage.remove(blogID, "/notes/multi+");
    await syncPaths(blogID, ["/notes/multi+/a.md", "/notes/multi+/b.md"]);

    var dropped = await Entry.get(blogID, "/notes/multi");
    expect(dropped && !dropped.deleted).toBeFalsy();

    var ids = await Entries.getListIDs(blogID, "entries", {});
    expect(ids).not.toContain("/notes/multi");
  });

  it("keeps a sibling file's entry when every file of its colliding + folder is removed", async function () {
    var blogID = this.blog.id;

    await writeAndSync(blogID, [
      ["/article.md", "# The Real Article"],
      ["/article.md+/a.md", "# A"],
      ["/article.md+/b.md", "# B"],
    ]);

    await storage.remove(blogID, "/article.md+");
    await syncPaths(blogID, ["/article.md+/a.md", "/article.md+/b.md"]);

    var entry = await Entry.get(blogID, "/article.md");
    expect(entry).toBeDefined();
    expect(entry.deleted).toBeFalsy();
    expect(entry.html.indexOf("The Real Article")).toBeGreaterThan(-1);
  });

  it("keeps a sibling file's entry when its colliding + folder is deleted", async function () {
    var blogID = this.blog.id;

    await writeAndSync(blogID, [
      ["/article.md", "# The Real Article"],
      ["/article.md+/extra.md", "# Extra"],
    ]);

    // Delete the colliding "+" folder outright.
    await storage.remove(blogID, "/article.md+");
    await syncPaths(blogID, ["/article.md+"]);

    var entry = await Entry.get(blogID, "/article.md");
    expect(entry).toBeDefined();
    expect(entry.deleted).toBeFalsy();
    expect(entry.html.indexOf("The Real Article")).toBeGreaterThan(-1);
  });

  it("rebuilds a colliding + folder once the blocking sibling file is deleted", async function () {
    var blogID = this.blog.id;

    await writeAndSync(blogID, [
      ["/article.md", "# The Real Article"],
      ["/article.md+/extra.md", "# Extra"],
    ]);

    // Remove the sibling file that was blocking the folder post.
    await storage.remove(blogID, "/article.md");
    await syncPaths(blogID, ["/article.md"]);

    var entry = await Entry.get(blogID, "/article.md");
    expect(entry).toBeDefined();
    expect(entry.deleted).toBeFalsy();
    expect(entry.html.indexOf("multi-file-post")).toBeGreaterThan(-1);
    expect(entry.html.indexOf("Extra")).toBeGreaterThan(-1);
  });

  it("drops the aggregate when a source exceeds the size limit and recovers after shrinking", async function () {
    var limit = require("build/converters/post-source-size").MARKDOWN.bytes;
    var blogID = this.blog.id;
    var flagsOf = async function (path) {
      return (await storage.stat(blogID, path)).flags;
    };

    await writeAndSync(blogID, [
      ["/album+/01.md", "# One"],
      ["/album+/02.md", "# Two"],
      // Grow one source past its converter limit.
      ["/album+/02.md", Buffer.alloc(limit + 1, 32)],
    ]);

    var aggregate = await Entry.get(blogID, "/album");
    // The stale folder post is dropped rather than left published.
    expect(aggregate && aggregate.deleted).toBe(true);

    expect(await flagsOf("/album+/02.md")).toEqual([
      { code: "POST_TOO_LARGE", size: limit + 1, limit: limit },
    ]);

    await writeAndSync(blogID, [["/album+/02.md", "# Two again"]]);

    var recovered = await Entry.get(blogID, "/album");
    expect(recovered).toBeTruthy();
    expect(recovered.deleted).toBeFalsy();
    expect(recovered.html).toContain("Two again");

    // The recovered source is no longer hidden on the dashboard.
    expect(await flagsOf("/album+/02.md")).toBeUndefined();
  });

  it("does not overwrite a sibling file when a draft folder post writes its preview", async function () {
    var blogID = this.blog.id;

    await writeAndSync(blogID, [
      // A real source file at the folder post's published path + .html
      ["/album.html", "<p>real sibling</p>"],
      ["/album+/01.md", "Draft: yes\n\n# Draft album"],
    ]);

    var aggregate = await Entry.get(blogID, "/album");
    expect(aggregate && aggregate.draft).toBe(true);
    // previewPath("/album") is "/album.html"; the sibling on disk
    // must be left untouched.
    var contents = await storage.read(blogID, "/album.html");
    expect(contents.toString()).toEqual("<p>real sibling</p>");
  });
});
