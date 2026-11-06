describe("sync multi-folder support", function () {
  var storage = require("storage/folder");
  var path = require("path");
  var async = require("async");
  var Entry = require("models/entry");
  var Entries = require("models/entries");
  var syncFolder = require("sync");

  // Runs fn once the promise resolves; calls fail with its error otherwise
  function after(promise, fail, fn) {
    promise.then(fn, fail);
  }

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

  it("handles renaming a directory to use the + convention", function (done) {
    var blogID = this.blog.id;

    syncFolder(blogID, function (err, folder, finish) {
      if (err) return done.fail(err);

      async.series(
        [
          function (next) {
            after(storage.write(blogID, "/images/photo.md", "# Photo"), next, function () {
              folder.update("/images/photo.md", next);
            });
          },
        ],
        function (err) {
          finish(err, function (finishErr) {
            if (err || finishErr) return done.fail(err || finishErr);

            Entry.get(blogID, "/images/photo.md", function (initialEntry) {
              expect(initialEntry).toBeDefined();

              after(storage.move(blogID, "/images", "/images+"), done.fail, function () {
                syncFolder(blogID, function (err2, folder2, finish2) {
                if (err2) return done.fail(err2);

                async.series(
                  [
                    function (next) {
                      folder2.update("/images/photo.md", next);
                    },
                    function (next) {
                      folder2.update("/images+/photo.md", next);
                    },
                    function (next) {
                      folder2.update("/images+", next);
                    },
                  ],
                  function (seriesErr) {
                    finish2(seriesErr, function (finishErr2) {
                      if (seriesErr || finishErr2)
                        return done.fail(seriesErr || finishErr2);

                      Entry.get(blogID, "/images", function (aggregatedEntry) {
                        expect(aggregatedEntry).toBeDefined();
                        expect(aggregatedEntry.deleted).toBeFalsy();
                        expect(aggregatedEntry.path).toEqual("/images");
                        expect(
                          aggregatedEntry.metadata._sourcePaths
                        ).toBeUndefined();

                        Entry.get(
                          blogID,
                          "/images/photo.md",
                          function (oldEntry) {
                            if (oldEntry) {
                              expect(oldEntry.deleted).toBe(true);
                            }
                            done();
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
        }
      );
    });
  });

  it("rebuilds the aggregated entry when a child file is removed", function (done) {
    var blogID = this.blog.id;

    syncFolder(blogID, function (err, folder, finish) {
      if (err) return done.fail(err);

      async.series(
        [
          function (next) {
            after(storage.write(blogID, "/album+/one.md", "# One"), next, function () {
              folder.update("/album+/one.md", next);
            });
          },
          function (next) {
            after(storage.write(blogID, "/album+/two.md", "# Two"), next, function () {
              folder.update("/album+/two.md", next);
            });
          },
        ],
        function (seriesErr) {
          finish(seriesErr, function (finishErr) {
            if (seriesErr || finishErr)
              return done.fail(seriesErr || finishErr);

            Entry.get(blogID, "/album", function (initialEntry) {
              expect(initialEntry).toBeDefined();
              expect(initialEntry.html.indexOf("One")).toBeGreaterThan(-1);
              expect(initialEntry.html.indexOf("Two")).toBeGreaterThan(-1);

              after(storage.remove(blogID, "/album+/two.md"), done.fail, function () {
                syncFolder(blogID, function (err2, folder2, finish2) {
                if (err2) return done.fail(err2);

                folder2.update("/album+/two.md", function (updateErr) {
                  finish2(updateErr, function (finishErr2) {
                    if (updateErr || finishErr2)
                      return done.fail(updateErr || finishErr2);

                    Entry.get(blogID, "/album", function (rebuiltEntry) {
                      expect(rebuiltEntry).toBeDefined();
                      expect(rebuiltEntry.deleted).toBeFalsy();
                      expect(
                        rebuiltEntry.html.indexOf("One")
                      ).toBeGreaterThan(-1);
                      expect(rebuiltEntry.html.indexOf("Two")).toBe(-1);
                      done();
                    });
                  });
                });
              });
              });
            });
          });
        }
      );
    });
  });

  it("drops the synthesized entry when the + folder is removed", function (done) {
    var blogID = this.blog.id;

    syncFolder(blogID, function (err, folder, finish) {
      if (err) return done.fail(err);

      async.series(
        [
          function (next) {
            after(storage.write(blogID, "/gallery+/a.md", "# A"), next, function () {
              folder.update("/gallery+/a.md", next);
            });
          },
          function (next) {
            after(storage.write(blogID, "/gallery+/b.md", "# B"), next, function () {
              folder.update("/gallery+/b.md", next);
            });
          },
        ],
        function (seriesErr) {
          finish(seriesErr, function (finishErr) {
            if (seriesErr || finishErr)
              return done.fail(seriesErr || finishErr);

            Entry.get(blogID, "/gallery", function (initialEntry) {
              expect(initialEntry).toBeDefined();
              expect(initialEntry.deleted).toBeFalsy();

              after(storage.remove(blogID, "/gallery+"), done.fail, function () {
                syncFolder(blogID, function (err2, folder2, finish2) {
                if (err2) return done.fail(err2);

                async.series(
                  [
                    function (next) {
                      folder2.update("/gallery+/a.md", next);
                    },
                    function (next) {
                      folder2.update("/gallery+/b.md", next);
                    },
                    function (next) {
                      folder2.update("/gallery+", next);
                    },
                  ],
                  function (seriesErr2) {
                    finish2(seriesErr2, function (finishErr2) {
                      if (seriesErr2 || finishErr2)
                        return done.fail(seriesErr2 || finishErr2);

                      Entry.get(blogID, "/gallery", function (droppedEntry) {
                        if (droppedEntry) {
                          expect(droppedEntry.deleted).toBe(true);
                        } else {
                          expect(droppedEntry).toBeFalsy();
                        }
                        done();
                      });
                    });
                  }
                );
              });
              });
            });
          });
        }
      );
    });
  });

  it("keeps the aggregate entry when Fix runs on server restart", function (done) {
    var Fix = require("sync/fix");
    var blog = this.blog;
    var blogID = blog.id;

    syncFolder(blogID, function (err, folder, finish) {
      if (err) return done.fail(err);

      async.series(
        [
          function (next) {
            after(storage.write(blogID, "/essay+/one.md", "# One"), next, function () {
              folder.update("/essay+/one.md", next);
            });
          },
          function (next) {
            after(storage.write(blogID, "/essay+/two.md", "# Two"), next, function () {
              folder.update("/essay+/two.md", next);
            });
          },
        ],
        function (seriesErr) {
          finish(seriesErr, function (finishErr) {
            if (seriesErr || finishErr)
              return done.fail(seriesErr || finishErr);

            Entry.get(blogID, "/essay", function (initialEntry) {
              expect(initialEntry).toBeDefined();
              expect(initialEntry.deleted).toBeFalsy();

              // Fix() runs on every client startup / server restart. The
              // folder post's aggregate lives at a "+"-stripped path with no
              // file behind it, so entry-ghosts must not treat it as a ghost.
              Fix(blog, function (fixErr) {
                if (fixErr) return done.fail(fixErr);

                Entry.get(blogID, "/essay", function (afterEntry) {
                  expect(afterEntry).toBeDefined();
                  expect(afterEntry.deleted).toBeFalsy();
                  expect(afterEntry.html.indexOf("One")).toBeGreaterThan(-1);
                  expect(afterEntry.html.indexOf("Two")).toBeGreaterThan(-1);
                  done();
                });
              });
            });
          });
        }
      );
    });
  });

  it("drops the aggregate through Fix when the + folder is gone", function (done) {
    var Fix = require("sync/fix");
    var blog = this.blog;
    var blogID = blog.id;

    syncFolder(blogID, function (err, folder, finish) {
      if (err) return done.fail(err);

      async.series(
        [
          function (next) {
            after(storage.write(blogID, "/essay+/one.md", "# One"), next, function () {
              folder.update("/essay+/one.md", next);
            });
          },
          function (next) {
            after(storage.write(blogID, "/essay+/two.md", "# Two"), next, function () {
              folder.update("/essay+/two.md", next);
            });
          },
        ],
        function (seriesErr) {
          finish(seriesErr, function (finishErr) {
            if (seriesErr || finishErr)
              return done.fail(seriesErr || finishErr);

            Entry.get(blogID, "/essay", function (initialEntry) {
              expect(initialEntry).toBeDefined();
              expect(initialEntry.deleted).toBeFalsy();

              // Remove the folder without letting sync see it, then let Fix
              // reconcile: the aggregate has no source folder left on disk, so
              // it is a genuine ghost and must be dropped.
              after(storage.remove(blogID, "/essay+"), done.fail, function () {
                Fix(blog, function (fixErr) {
                if (fixErr) return done.fail(fixErr);

                Entry.get(blogID, "/essay", function (afterEntry) {
                  if (afterEntry) {
                    expect(afterEntry.deleted).toBe(true);
                  } else {
                    expect(afterEntry).toBeFalsy();
                  }
                  done();
                });
              });
              });
            });
          });
        }
      );
    });
  });

  it("drops the aggregate when the + folder is replaced by a file", function (done) {
    var Fix = require("sync/fix");
    var blog = this.blog;
    var blogID = blog.id;

    syncFolder(blogID, function (err, folder, finish) {
      if (err) return done.fail(err);

      async.series(
        [
          function (next) {
            after(storage.write(blogID, "/essay+/one.md", "# One"), next, function () {
              folder.update("/essay+/one.md", next);
            });
          },
          function (next) {
            after(storage.write(blogID, "/essay+/two.md", "# Two"), next, function () {
              folder.update("/essay+/two.md", next);
            });
          },
        ],
        function (seriesErr) {
          finish(seriesErr, function (finishErr) {
            if (seriesErr || finishErr)
              return done.fail(seriesErr || finishErr);

            Entry.get(blogID, "/essay", function (initialEntry) {
              expect(initialEntry).toBeDefined();

              // Swap the directory for a plain file at the same path.
              after(storage.remove(blogID, "/essay+").then(function () {
                return storage.write(blogID, "/essay+", "not a folder");
              }), done.fail, function () {
                syncFolder(blogID, function (err2, folder2, finish2) {
                if (err2) return done.fail(err2);

                folder2.update("/essay+", function (updateErr) {
                  finish2(updateErr, function (finishErr2) {
                    if (finishErr2) return done.fail(finishErr2);

                    Entry.get(blogID, "/essay", function (afterUpdate) {
                      if (afterUpdate) {
                        expect(afterUpdate.deleted).toBe(true);
                      } else {
                        expect(afterUpdate).toBeFalsy();
                      }

                      // Fix() also treats a non-directory "+" path as a ghost.
                      Fix(blog, function (fixErr) {
                        if (fixErr) return done.fail(fixErr);

                        Entry.get(blogID, "/essay", function (afterFix) {
                          if (afterFix) {
                            expect(afterFix.deleted).toBe(true);
                          } else {
                            expect(afterFix).toBeFalsy();
                          }
                          done();
                        });
                      });
                    });
                  });
                });
              });
              });
            });
          });
        }
      );
    });
  });

  it("keeps a sibling post when a plain +-suffixed file shares its stripped path", function (done) {
    var blogID = this.blog.id;

    syncFolder(blogID, function (err, folder, finish) {
      if (err) return done.fail(err);

      async.series(
        [
          function (next) {
            after(storage.write(blogID, "/post.md", "# The Real Post"), next, function () {
              folder.update("/post.md", next);
            });
          },
          function (next) {
            // A file that just happens to end in "+", never a folder.
            after(storage.write(blogID, "/post.md+", "leftover"), next, function () {
              folder.update("/post.md+", next);
            });
          },
        ],
        function (seriesErr) {
          finish(seriesErr, function (finishErr) {
            if (seriesErr || finishErr)
              return done.fail(seriesErr || finishErr);

            Entry.get(blogID, "/post.md", function (entry) {
              expect(entry).toBeDefined();
              expect(entry.deleted).toBeFalsy();
              expect(entry.html.indexOf("The Real Post")).toBeGreaterThan(-1);
              done();
            });
          });
        }
      );
    });
  });

  it("keeps a sibling file's entry when a + folder collides with its stripped path", function (done) {
    var blogID = this.blog.id;

    syncFolder(blogID, function (err, folder, finish) {
      if (err) return done.fail(err);

      async.series(
        [
          function (next) {
            after(storage.write(blogID, "/article.md", "# The Real Article"), next, function () {
              folder.update("/article.md", next);
            });
          },
          function (next) {
            after(storage.write(blogID, "/article.md+/extra.md", "# Extra"), next, function () {
              folder.update("/article.md+/extra.md", next);
            });
          },
        ],
        function (seriesErr) {
          finish(seriesErr, function (finishErr) {
            if (seriesErr || finishErr)
              return done.fail(seriesErr || finishErr);

            Entry.get(blogID, "/article.md", function (entry) {
              expect(entry).toBeDefined();
              expect(entry.deleted).toBeFalsy();
              expect(entry.html.indexOf("The Real Article")).toBeGreaterThan(
                -1
              );
              expect(entry.html.indexOf("multi-file-post")).toBe(-1);
              done();
            });
          });
        }
      );
    });
  });

  it("drops the aggregate when every file is removed and only the files are synced", function (done) {
    var blogID = this.blog.id;

    syncFolder(blogID, function (err, folder, finish) {
      if (err) return done.fail(err);

      async.series(
        [
          function (next) {
            after(storage.write(blogID, "/notes/multi+/a.md", "# A"), next, function () {
              folder.update("/notes/multi+/a.md", next);
            });
          },
          function (next) {
            after(storage.write(blogID, "/notes/multi+/b.md", "# B"), next, function () {
              folder.update("/notes/multi+/b.md", next);
            });
          },
        ],
        function (seriesErr) {
          finish(seriesErr, function (finishErr) {
            if (seriesErr || finishErr)
              return done.fail(seriesErr || finishErr);

            Entry.get(blogID, "/notes/multi", function (initialEntry) {
              expect(initialEntry).toBeDefined();
              expect(initialEntry.deleted).toBeFalsy();

              // Like a push to a repository: the files and the folder are
              // gone, and only the file paths are reported.
              after(storage.remove(blogID, "/notes/multi+"), done.fail, function () {
                syncFolder(blogID, function (err2, folder2, finish2) {
                if (err2) return done.fail(err2);

                async.series(
                  [
                    function (next) {
                      folder2.update("/notes/multi+/a.md", next);
                    },
                    function (next) {
                      folder2.update("/notes/multi+/b.md", next);
                    },
                  ],
                  function (seriesErr2) {
                    finish2(seriesErr2, function (finishErr2) {
                      if (seriesErr2 || finishErr2)
                        return done.fail(seriesErr2 || finishErr2);

                      Entry.get(blogID, "/notes/multi", function (dropped) {
                        expect(dropped && !dropped.deleted).toBeFalsy();

                        Entries.getListIDs(
                          blogID,
                          "entries",
                          {},
                          function (listErr, ids) {
                            if (listErr) return done.fail(listErr);
                            expect(ids).not.toContain("/notes/multi");
                            done();
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
        }
      );
    });
  });

  it("keeps a sibling file's entry when every file of its colliding + folder is removed", function (done) {
    var blogID = this.blog.id;

    syncFolder(blogID, function (err, folder, finish) {
      if (err) return done.fail(err);

      async.series(
        [
          function (next) {
            after(storage.write(blogID, "/article.md", "# The Real Article"), next, function () {
              folder.update("/article.md", next);
            });
          },
          function (next) {
            after(storage.write(blogID, "/article.md+/a.md", "# A"), next, function () {
              folder.update("/article.md+/a.md", next);
            });
          },
          function (next) {
            after(storage.write(blogID, "/article.md+/b.md", "# B"), next, function () {
              folder.update("/article.md+/b.md", next);
            });
          },
        ],
        function (seriesErr) {
          finish(seriesErr, function (finishErr) {
            if (seriesErr || finishErr)
              return done.fail(seriesErr || finishErr);

            after(storage.remove(blogID, "/article.md+"), done.fail, function () {
              syncFolder(blogID, function (err2, folder2, finish2) {
              if (err2) return done.fail(err2);

              async.series(
                [
                  function (next) {
                    folder2.update("/article.md+/a.md", next);
                  },
                  function (next) {
                    folder2.update("/article.md+/b.md", next);
                  },
                ],
                function (seriesErr2) {
                  finish2(seriesErr2, function (finishErr2) {
                    if (seriesErr2 || finishErr2)
                      return done.fail(seriesErr2 || finishErr2);

                    Entry.get(blogID, "/article.md", function (entry) {
                      expect(entry).toBeDefined();
                      expect(entry.deleted).toBeFalsy();
                      expect(
                        entry.html.indexOf("The Real Article")
                      ).toBeGreaterThan(-1);
                      done();
                    });
                  });
                }
              );
            });
            });
          });
        }
      );
    });
  });

  it("keeps a sibling file's entry when its colliding + folder is deleted", function (done) {
    var blogID = this.blog.id;

    syncFolder(blogID, function (err, folder, finish) {
      if (err) return done.fail(err);

      async.series(
        [
          function (next) {
            after(storage.write(blogID, "/article.md", "# The Real Article"), next, function () {
              folder.update("/article.md", next);
            });
          },
          function (next) {
            after(storage.write(blogID, "/article.md+/extra.md", "# Extra"), next, function () {
              folder.update("/article.md+/extra.md", next);
            });
          },
        ],
        function (seriesErr) {
          finish(seriesErr, function (finishErr) {
            if (seriesErr || finishErr)
              return done.fail(seriesErr || finishErr);

            // Delete the colliding "+" folder outright.
            after(storage.remove(blogID, "/article.md+"), done.fail, function () {
              syncFolder(blogID, function (err2, folder2, finish2) {
              if (err2) return done.fail(err2);

              folder2.update("/article.md+", function (updateErr) {
                finish2(updateErr, function (finishErr2) {
                  if (finishErr2) return done.fail(finishErr2);

                  Entry.get(blogID, "/article.md", function (entry) {
                    expect(entry).toBeDefined();
                    expect(entry.deleted).toBeFalsy();
                    expect(
                      entry.html.indexOf("The Real Article")
                    ).toBeGreaterThan(-1);
                    done();
                  });
                });
              });
            });
            });
          });
        }
      );
    });
  });

  it("rebuilds a colliding + folder once the blocking sibling file is deleted", function (done) {
    var blogID = this.blog.id;

    syncFolder(blogID, function (err, folder, finish) {
      if (err) return done.fail(err);

      async.series(
        [
          function (next) {
            after(storage.write(blogID, "/article.md", "# The Real Article"), next, function () {
              folder.update("/article.md", next);
            });
          },
          function (next) {
            after(storage.write(blogID, "/article.md+/extra.md", "# Extra"), next, function () {
              folder.update("/article.md+/extra.md", next);
            });
          },
        ],
        function (seriesErr) {
          finish(seriesErr, function (finishErr) {
            if (seriesErr || finishErr)
              return done.fail(seriesErr || finishErr);

            // Remove the sibling file that was blocking the folder post.
            after(storage.remove(blogID, "/article.md"), done.fail, function () {
              syncFolder(blogID, function (err2, folder2, finish2) {
              if (err2) return done.fail(err2);

              folder2.update("/article.md", function (updateErr) {
                finish2(updateErr, function (finishErr2) {
                  if (finishErr2) return done.fail(finishErr2);

                  Entry.get(blogID, "/article.md", function (entry) {
                    expect(entry).toBeDefined();
                    expect(entry.deleted).toBeFalsy();
                    expect(
                      entry.html.indexOf("multi-file-post")
                    ).toBeGreaterThan(-1);
                    expect(entry.html.indexOf("Extra")).toBeGreaterThan(-1);
                    done();
                  });
                });
              });
            });
            });
          });
        }
      );
    });
  });

  it("drops the aggregate when a source exceeds the size limit and recovers after shrinking", function (done) {
    var limit = require("build/converters/post-source-size").MARKDOWN.bytes;
    var IgnoredFiles = require("models/ignoredFiles");
    var blogID = this.blog.id;

    syncFolder(blogID, function (err, folder, finish) {
      if (err) return done.fail(err);

      async.series(
        [
          function (next) {
            after(storage.write(blogID, "/album+/01.md", "# One"), next, function () {
              folder.update("/album+/01.md", next);
            });
          },
          function (next) {
            after(storage.write(blogID, "/album+/02.md", "# Two"), next, function () {
              folder.update("/album+/02.md", next);
            });
          },
          function (next) {
            // Grow one source past its converter limit.
            after(storage.write(blogID, "/album+/02.md", Buffer.alloc(limit + 1, 32)), next, function () {
              folder.update("/album+/02.md", next);
            });
          },
        ],
        function (seriesErr) {
          finish(seriesErr, function (finishErr) {
            if (seriesErr || finishErr)
              return done.fail(seriesErr || finishErr);

            Entry.get(blogID, "/album", function (aggregate) {
              // The stale folder post is dropped rather than left published.
              expect(aggregate && aggregate.deleted).toBe(true);

              IgnoredFiles.getStatus(blogID, "/album+/02.md", function (
                err,
                reason
              ) {
                if (err) return done.fail(err);
                expect(reason).toBe("TOO_LARGE");

                syncFolder(blogID, function (err2, folder2, finish2) {
                  if (err2) return done.fail(err2);

                  after(storage.write(blogID, "/album+/02.md", "# Two again"), done.fail, function () {
                    folder2.update("/album+/02.md", function (updateErr) {
                    finish2(updateErr, function (finishErr2) {
                      if (updateErr || finishErr2)
                        return done.fail(updateErr || finishErr2);

                      Entry.get(blogID, "/album", function (recovered) {
                        expect(recovered).toBeTruthy();
                        expect(recovered.deleted).toBeFalsy();
                        expect(recovered.html).toContain("Two again");

                        IgnoredFiles.getStatus(
                          blogID,
                          "/album+/02.md",
                          function (err3, reason3) {
                            if (err3) return done.fail(err3);
                            // The recovered source is no longer hidden on
                            // the dashboard.
                            expect(reason3).toBeFalsy();
                            done();
                          }
                        );
                      });
                    });
                  });
                  });
                });
              });
            });
          });
        }
      );
    });
  });

  it("does not overwrite a sibling file when a draft folder post writes its preview", function (done) {
    var blogID = this.blog.id;

    syncFolder(blogID, function (err, folder, finish) {
      if (err) return done.fail(err);

      async.series(
        [
          function (next) {
            // A real source file at the folder post's published path + .html
            after(storage.write(blogID, "/album.html", "<p>real sibling</p>"), next, function () {
              folder.update("/album.html", next);
            });
          },
          function (next) {
            after(storage.write(blogID, "/album+/01.md", "Draft: yes\n\n# Draft album"), next, function () {
              folder.update("/album+/01.md", next);
            });
          },
        ],
        function (seriesErr) {
          finish(seriesErr, function (finishErr) {
            if (seriesErr || finishErr)
              return done.fail(seriesErr || finishErr);

            Entry.get(blogID, "/album", function (aggregate) {
              expect(aggregate && aggregate.draft).toBe(true);
              // previewPath("/album") is "/album.html"; the sibling on disk
              // must be left untouched.
              storage.read(blogID, "/album.html").then(function (contents) {
                expect(contents.toString()).toEqual("<p>real sibling</p>");
                done();
              }, done.fail);
            });
          });
        }
      );
    });
  });
});
