describe("update", function () {
  var sync = require("../index");
  var fs = require("fs-extra");
  var async = require("async");
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
    var content = '';

    var ctx = this;

    ctx.writeAndSync(path, content, function (err) {
      if (err) return done.fail(err);
      ctx.writeAndSync(newPath, content, function (err) {
        if (err) return done.fail(err);
        ctx.removeAndSync(path, function (err) {
          if (err) return done.fail(err);
          ctx.checkEntry({path, deleted: true}, function(err, entry) {
            if (err) return done.fail(err);
            ctx.checkEntry({path: newPath, deleted: false}, function(err, newPathEntry) {
              if (err) return done.fail(err);

              expect(newPathEntry.guid).not.toBe(entry.guid);
              expect(newPathEntry.created).not.toBe(entry.created);
              done();
            });
          });
        });
      });
    });
  });

  it("does not reset the created date for published drafts", function (done) {
    var path = '/Drafts/Example.txt';
    var newPath = '/Example.txt';
    var content = 'Hello, world';

    var ctx = this;

    ctx.writeAndSync(path, content, function (err) {
      if (err) return done.fail(err);
      ctx.writeAndSync(newPath, content, function (err) {
        if (err) return done.fail(err);
        ctx.removeAndSync(path, function (err) {
          if (err) return done.fail(err);
          ctx.checkEntry({path, deleted: true}, function(err, entry) {
            if (err) return done.fail(err);
            ctx.checkEntry({path: newPath, deleted: false}, function(err, newPathEntry) {
              if (err) return done.fail(err);

              expect(newPathEntry.guid).not.toBe(entry.guid);
              expect(newPathEntry.created).not.toBe(entry.created);
              done();
            });
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
        content: this.fake.file({title: i + '-' + Date.now()}),
      });

    sync(ctx.blog.id, function (err, folder, done) {
      if (err) return testDone.fail(err);

      // Write initial files
      async.eachSeries(
        items,
        function (item, next) {
          fs.outputFileSync(folder.path + item.oldPath, item.content, "utf-8");
          folder.update(item.oldPath, next);
        },
        function (err) {
          if (err) return testDone.fail(err);

          done(null, function (err) {
            if (err) return testDone.fail(err);

            sync(ctx.blog.id, function (err, folder, done) {
              if (err) return testDone.fail(err);

              // Move files
              async.eachSeries(
                items,
                function (item, next) {
                  fs.moveSync(
                    folder.path + item.oldPath,
                    folder.path + item.newPath
                  );
                  folder.update(item.oldPath, function () {
                    folder.update(item.newPath, next);
                  });
                },
                function (err) {
                  if (err) return testDone.fail(err);

                  done(null, function (err) {
                    if (err) return testDone.fail(err);

                    async.each(
                      items,
                      function (item, next) {
                        ctx.checkRename(item.oldPath, item.newPath, next);
                      },
                      testDone
                    );
                  });
                }
              );
            });
          });
        }
      );
    });
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

            sync(blogID, function (err, folder, done) {
              if (err) return testDone.fail(err);

              async.series(
                [
                  function (next) {
                    fs.removeSync(folder.path + path);
                    folder.update(path, next);
                  },
                  function (next) {
                    fs.removeSync(folder.path + ghostPath);
                    folder.update(ghostPath, function (err) {
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
                function (err) {
                  if (err) return testDone.fail(err);

                  done(null, function (err) {
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
                  });
                }
              );
            });
          });
        });
      });
    });
  });

  it("detects a renamed file", function (testDone) {
    var path = this.fake.path(".txt");
    var newPath = this.fake.path(".txt");
    var content = this.fake.file();
    var checkRename = this.checkRename;

    sync(this.blog.id, function (err, folder, done) {
      if (err) return testDone.fail(err);

      fs.outputFileSync(folder.path + path, content, "utf-8");

      folder.update(path, function (err) {
        if (err) return testDone.fail(err);

        fs.moveSync(folder.path + path, folder.path + newPath);

        async.series(
          [folder.update.bind(this, path), folder.update.bind(this, newPath)],
          function (err) {
            if (err) return testDone.fail(err);

            done(null, function (err) {
              if (err) return testDone.fail(err);
              checkRename(path, newPath, testDone);
            });
          }
        );
      });
    });
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
      checkEntry({ path: oldPath, deleted: true, guid: '' }, function (err, entry) {
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
      });
    };

    this.removeAndSync = function (path, callback) {
      sync(blog.id, function (err, folder, done) {
        if (err) return callback(err);

        fs.removeSync(folder.path + path);

        folder.update(path, function (err) {
          if (err) return callback(err);

          done(null, function (err) {
            if (err) return callback(err);

            checkEntry({ path: path, deleted: true }, callback);
          });
        });
      });
    };
    this.writeAndSync = function (path, contents, callback) {
      sync(blog.id, function (err, folder, done) {
        if (err) return callback(err);

        fs.outputFileSync(folder.path + path, contents, "utf-8");

        folder.update(path, function (err) {
          if (err) return callback(err);

          done(null, function (err) {
            if (err) return callback(err);

            checkEntry({ path: path, deleted: false }, callback);
          });
        });
      });
    };
  });
});
