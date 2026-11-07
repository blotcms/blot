describe("update", function () {
  var sync = require("../index");
  var storage = require("storage/folder");

  // Calls next(err) when the promise settles
  function settle(promise, next) {
    promise.then(function () {
      next();
    }, next);
  }

  // Runs work(folder, finish) in a sync of the blog, which ends when work
  // calls finish(err), then calls callback(err) once the sync has finished
  function syncThen(blogID, work, callback) {
    sync(blogID, function (folder) {
      return new Promise(function (resolve, reject) {
        work(folder, function (err) {
          if (err) return reject(err);
          resolve();
        });
      });
    }).then(function () {
      callback(null);
    }, callback);
  }

  var {
    series,
    eachSeries,
    each,
  } = require("../../../scripts/tests/util/callbacks");
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

  it("detects a large number of renamed files", function (testDone) {
    var items = [];
    var ctx = this;
    var usedPaths = new Set();

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

    syncThen(
      ctx.blog.id,
      function (folder, finish) {
        // Write initial files
        eachSeries(
          items,
          function (item, next) {
            settle(
              storage.write(ctx.blog.id, item.oldPath, item.content),
              function (err) {
                if (err) return next(err);
                folder
                  .update(item.oldPath)
                  .then((result) => next(null, result), next);
              }
            );
          },
          finish
        );
      },
      function (err) {
        if (err) return testDone.fail(err);

        syncThen(
          ctx.blog.id,
          function (folder, finish) {
            // Move files
            eachSeries(
              items,
              function (item, next) {
                settle(
                  storage.move(ctx.blog.id, item.oldPath, item.newPath),
                  function (err) {
                    if (err) return next(err);
                    folder
                      .update(item.oldPath)
                      .then(
                        () => null,
                        (updateErr) => updateErr
                      )
                      .then(function () {
                        folder
                          .update(item.newPath)
                          .then((result) => next(null, result), next);
                      });
                  }
                );
              },
              finish
            );
          },
          function (err) {
            if (err) return testDone.fail(err);

            each(
              items,
              function (item, next) {
                ctx.checkRename(item.oldPath, item.newPath, next);
              },
              testDone
            );
          }
        );
      }
    );
  });

  it("skips missing deleted-entry records while detecting renames", function (testDone) {
    var ctx = this;
    var blogID = ctx.blog.id;

    var path = ctx.fake.path(".txt");
    var newPath = ctx.fake.path(".txt");
    var ghostPath = ctx.fake.path(".txt");
    var ghostNewPath = ctx.fake.path(".txt");

    // Unique titles avoid a permalink collision between these two entries,
    // which would otherwise get a "-2" suffix and break checkRename's
    // exact permalink-reuse assertion.
    var content = ctx.fake.file({ title: ctx.fake.random.uuid() });
    var ghostContent = ctx.fake.file({ title: ctx.fake.random.uuid() });
    var ghostEntryID;

    ctx.writeAndSync(path, content, function (err) {
      if (err) return testDone.fail(err);

      ctx.writeAndSync(newPath, content, function (err) {
        if (err) return testDone.fail(err);

        ctx.writeAndSync(ghostPath, ghostContent, function (err) {
          if (err) return testDone.fail(err);

          ctx.writeAndSync(ghostNewPath, ghostContent, function (err) {
            if (err) return testDone.fail(err);

            syncThen(
              blogID,
              function (folder, finish) {
                series(
                  [
                    function (next) {
                      settle(storage.remove(blogID, path), function (err) {
                        if (err) return next(err);
                        folder
                          .update(path)
                          .then((result) => next(null, result), next);
                      });
                    },
                    function (next) {
                      settle(storage.remove(blogID, ghostPath), function (err) {
                        if (err) return next(err);
                        folder
                          .update(ghostPath)
                          .then(
                            () => null,
                            (updateErr) => updateErr
                          )
                          .then(function (err) {
                            if (err) return next(err);

                            ctx.checkEntry(
                              { path: ghostPath, deleted: true },
                              function (err, entry) {
                                if (err) return next(err);
                                ghostEntryID = entry.id;
                                next();
                              }
                            );
                          });
                      });
                    },
                    function (next) {
                      redis
                        .del(entryKey(blogID, ghostPath))
                        .then(function () {
                          var deletedListKey = "blog:" + blogID + ":deleted";

                          return redis.zScore(deletedListKey, ghostEntryID);
                        })
                        .then(function (score) {
                          expect(score).not.toBeNull();
                          next();
                        })
                        .catch(next);
                    },
                  ],
                  finish
                );
              },
              function (err) {
                if (err) return testDone.fail(err);

                ctx.checkRename(path, newPath, function (err) {
                  if (err) return testDone.fail(err);

                  ctx.checkEntry(
                    { path: ghostPath, ignored: true },
                    function (err, entry) {
                      if (err) return testDone.fail(err);
                      expect(entry).toBeFalsy();

                      ctx.checkEntry(
                        { path: ghostNewPath, deleted: false },
                        function (err) {
                          if (err) return testDone.fail(err);
                          testDone();
                        }
                      );
                    }
                  );
                });
              }
            );
          });
        });
      });
    });
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
