describe("update", function () {
  var { promisify } = require("util");
  var sync = require("../index");
  var storage = require("storage/folder");

  var redis = require("models/client");
  var entryKey = require("models/entry/key").entry;

  it("detects a renamed file across multiple syncs", function (done) {
    var path = this.fake.path(".txt");
    var newPath = this.fake.path(".txt");
    var content = this.fake.file();

    var ctx = this;

    ctx.writeAndSync(path, content, function (err) {
      if (err) return done.fail(err);
      ctx.writeAndSync(newPath, content, function (err) {
        if (err) return done.fail(err);
        ctx.removeAndSync(path, function (err) {
          if (err) return done.fail(err);
          ctx.checkRename(path, newPath, done);
        });
      });
    });
  });

  it("ignores a renamed file if it is empty", function (done) {
    var path = this.fake.path(".txt");
    var newPath = this.fake.path(".txt");
    var content = "";

    var ctx = this;

    ctx.writeAndSync(path, content, function (err) {
      if (err) return done.fail(err);
      ctx.writeAndSync(newPath, content, function (err) {
        if (err) return done.fail(err);
        ctx.removeAndSync(path, function (err) {
          if (err) return done.fail(err);
          ctx.checkEntry({ path, deleted: true }, function (err, entry) {
            if (err) return done.fail(err);
            ctx.checkEntry(
              { path: newPath, deleted: false },
              function (err, newPathEntry) {
                if (err) return done.fail(err);

                expect(newPathEntry.guid).not.toBe(entry.guid);
                expect(newPathEntry.created).not.toBe(entry.created);
                done();
              }
            );
          });
        });
      });
    });
  });

  it("does not reset the created date for published drafts", function (done) {
    var path = "/Drafts/Example.txt";
    var newPath = "/Example.txt";
    var content = "Hello, world";

    var ctx = this;

    ctx.writeAndSync(path, content, function (err) {
      if (err) return done.fail(err);
      ctx.writeAndSync(newPath, content, function (err) {
        if (err) return done.fail(err);
        ctx.removeAndSync(path, function (err) {
          if (err) return done.fail(err);
          ctx.checkEntry({ path, deleted: true }, function (err, entry) {
            if (err) return done.fail(err);
            ctx.checkEntry(
              { path: newPath, deleted: false },
              function (err, newPathEntry) {
                if (err) return done.fail(err);

                expect(newPathEntry.guid).not.toBe(entry.guid);
                expect(newPathEntry.created).not.toBe(entry.created);
                done();
              }
            );
          });
        });
      });
    });
  });

  it("detects a large number of renamed files", async function () {
    var items = [];
    var ctx = this;
    var usedPaths = new Set();
    var checkRename = promisify(ctx.checkRename);

    function uniquePath(ext) {
      var path;

      do {
        path = ctx.fake.path(ext);
      } while (usedPaths.has(path));

      usedPaths.add(path);

      return path;
    }

    // Create 100 fake files
    for (var i = 0; i < 10; i++)
      items.push({
        oldPath: uniquePath(".txt"),
        newPath: uniquePath(".txt"),
        content: this.fake.file({ title: i + "-" + Date.now() }),
      });

    // Write initial files
    await sync(ctx.blog.id, async function (folder) {
      for (const item of items) {
        await storage.write(ctx.blog.id, item.oldPath, item.content);
        await folder.update(item.oldPath);
      }
    });

    // Move files
    await sync(ctx.blog.id, async function (folder) {
      for (const item of items) {
        await storage.move(ctx.blog.id, item.oldPath, item.newPath);
        // The old path no longer exists, so its update may fail
        await folder.update(item.oldPath).catch(() => null);
        await folder.update(item.newPath);
      }
    });

    await Promise.all(
      items.map((item) => checkRename(item.oldPath, item.newPath))
    );
  });

  it("skips missing deleted-entry records while detecting renames", async function () {
    var ctx = this;
    var blogID = ctx.blog.id;
    var writeAndSync = promisify(ctx.writeAndSync);
    var checkEntry = promisify(ctx.checkEntry);
    var checkRename = promisify(ctx.checkRename);

    var path = ctx.fake.path(".txt");
    var newPath = ctx.fake.path(".txt");
    var ghostPath = ctx.fake.path(".txt");
    var ghostNewPath = ctx.fake.path(".txt");

    // Unique titles avoid a permalink collision between these two entries,
    // which would otherwise get a "-2" suffix and break checkRename's
    // exact permalink-reuse assertion.
    var content = ctx.fake.file({ title: ctx.fake.random.uuid() });
    var ghostContent = ctx.fake.file({ title: ctx.fake.random.uuid() });

    await writeAndSync(path, content);
    await writeAndSync(newPath, content);
    await writeAndSync(ghostPath, ghostContent);
    await writeAndSync(ghostNewPath, ghostContent);

    await sync(blogID, async function (folder) {
      await storage.remove(blogID, path);
      await folder.update(path);

      await storage.remove(blogID, ghostPath);
      await folder.update(ghostPath);

      var ghostEntry = await checkEntry({ path: ghostPath, deleted: true });

      await redis.del(entryKey(blogID, ghostPath));

      var deletedListKey = "blog:" + blogID + ":deleted";
      var score = await redis.zScore(deletedListKey, ghostEntry.id);
      expect(score).not.toBeNull();
    });

    await checkRename(path, newPath);

    var ignored = await checkEntry({ path: ghostPath, ignored: true });
    expect(ignored).toBeFalsy();

    await checkEntry({ path: ghostNewPath, deleted: false });
  });

  it("carries the same-day creation time through a rename when metadata specifies a date-only value", function (testDone) {
    var moment = require("moment");
    var path = this.fake.path(".txt");
    var newPath = this.fake.path(".txt");
    // Date-only metadata matching today has no time-of-day. The file is
    // about to be created and immediately renamed, both within today, so
    // once the rename is detected the resulting entry's dateStamp should
    // pick up the entry's real creation time rather than staying at
    // midnight (see build/prepare/dateStamp and sync/renames.js).
    var dateOnly = moment.utc().format("M/D/YYYY");
    var content = "Date: " + dateOnly + "\n\n" + this.fake.file();
    var ctx = this;
    var blogID = this.blog.id;

    sync(blogID, async function (folder) {
      await storage.write(blogID, path, content);
      await folder.update(path);
      await storage.move(blogID, path, newPath);
      await folder.update(path);
      await folder.update(newPath);
    }).then(function () {
      ctx.checkEntry({ path: newPath, deleted: false }, function (err, entry) {
        if (err) return testDone.fail(err);

        expect(moment.utc(entry.dateStamp).format("YYYY-MM-DD HH:mm")).toEqual(
          moment.utc(entry.created).format("YYYY-MM-DD HH:mm")
        );

        testDone();
      });
    }, testDone.fail);
  });

  it("detects a renamed file", function (testDone) {
    var path = this.fake.path(".txt");
    var newPath = this.fake.path(".txt");
    var content = this.fake.file();
    var checkRename = this.checkRename;
    var blogID = this.blog.id;

    sync(blogID, async function (folder) {
      await storage.write(blogID, path, content);
      await folder.update(path);
      await storage.move(blogID, path, newPath);
      await folder.update(path);
      await folder.update(newPath);
    }).then(function () {
      checkRename(path, newPath, testDone);
    }, testDone.fail);
  });

  // Set up a test blog before each test
  global.test.blog();

  // Expose methods for creating fake files, paths, etc.
  beforeEach(function () {
    this.fake = global.test.fake;
  });

  // helper functions
  beforeEach(function () {
    var blog = this.blog;
    var checkEntry = global.test.CheckEntry(blog.id);
    this.checkEntry = checkEntry;

    this.checkRename = function (oldPath, newPath, callback) {
      checkEntry(
        { path: oldPath, deleted: true, guid: "" },
        function (err, entry) {
          if (err) return callback(err);

          checkEntry(
            {
              path: newPath,
              url: entry.permalink,
              created: entry.created,
              deleted: false,
            },
            function (err) {
              if (err) return callback(err);
              callback();
            }
          );
        }
      );
    };

    this.removeAndSync = function (path, callback) {
      sync(blog.id, async function (folder) {
        await storage.remove(blog.id, path);
        await folder.update(path);
      }).then(function () {
        checkEntry({ path: path, deleted: true }, callback);
      }, callback);
    };
    this.writeAndSync = function (path, contents, callback) {
      sync(blog.id, async function (folder) {
        await storage.write(blog.id, path, contents);
        await folder.update(path);
      }).then(function () {
        checkEntry({ path: path, deleted: false }, callback);
      }, callback);
    };
  });
});
