describe("update", function () {
  var sync = require("../index");
  var fs = require("fs-extra");
  var build = require("build");

  // The "rebuilds an entry if the source file changes" spec below writes
  // the source file every 10ms for ~3 seconds while sync.update recurses
  // to catch up (see app/sync/update/index.js), so it can legitimately take
  // longer than Jasmine's 5 second default under load, causing an
  // intermittent timeout (and a stray late failure attributed to whichever
  // spec runs next).
  global.test.timeout(15 * 1000);

  // Set up a test blog before each test
  global.test.blog();

  // The blog's folder on disk, which these specs change directly
  let blogDirectory;

  beforeEach(function () {
    blogDirectory = this.blogDirectory;
  });

  // Expose methods for creating fake files, paths, etc.
  beforeEach(function () {
    this.fake = global.test.fake;
  });

  beforeEach(function () {
    this.checkEntry = global.test.CheckEntry(this.blog.id);
  });

  it("rebuilds an entry if the source file changes", function (testDone) {
    const path = this.fake.path(".txt");
    let content = 1;
    const checkEntry = this.checkEntry;

    sync(this.blog.id, function (err, folder, done) {
      if (err) testDone.fail(err);

      fs.outputFileSync(blogDirectory + path, content.toString(), "utf-8");

      const poll = setInterval(function () {
        content = content + 1;
        console.log("setting content to", content.toString());
        fs.outputFileSync(blogDirectory + path, content.toString(), "utf-8");
        if (content > 300) {
          console.log("cleaning interval at:", content.toString());
          clearInterval(poll);
        }
      }, 10);

      folder.update(path, function (err) {
        // Stop the background writes as soon as update() has read the file.
        // Left running, this interval can keep writing into the blog's
        // folder well past this test's own completion (or a slow-CI
        // Jasmine timeout), racing a later test's teardown and causing an
        // ENOTEMPTY when it tries to remove a directory this interval is
        // still writing into.
        clearInterval(poll);

        if (err) testDone.fail(err);

        checkEntry(
          { path: path, html: `<p>${content.toString()}</p>` },
          function (err) {
            if (err) testDone.fail(err);
            done(null, testDone);
          }
        );
      });
    });
  });


  it("creates an entry from a new file", function (testDone) {
    var path = this.fake.path(".txt");
    var content = this.fake.file();
    var checkEntry = this.checkEntry;

    sync(this.blog.id, function (err, folder, done) {
      if (err) testDone.fail(err);

      fs.outputFileSync(blogDirectory + path, content, "utf-8");
      folder.update(path, function (err) {
        if (err) testDone.fail(err);

        checkEntry({ path: path }, function (err) {
          if (err) testDone.fail(err);

          done(null, testDone);
        });
      });
    });
  });

  it("deletes an entry when you remove the file", function (testDone) {
    var path = this.fake.path(".txt");
    var content = this.fake.file();
    var checkEntry = this.checkEntry;

    sync(this.blog.id, function (err, folder, done) {
      if (err) testDone.fail(err);

      fs.outputFileSync(blogDirectory + path, content, "utf-8");
      folder.update(path, function (err) {
        if (err) testDone.fail(err);

        checkEntry({ path: path, deleted: false }, function (err) {
          if (err) testDone.fail(err);

          fs.removeSync(blogDirectory + path);
          folder.update(path, function (err) {
            if (err) testDone.fail(err);
            checkEntry({ path: path, deleted: true }, function (err) {
              if (err) testDone.fail(err);

              done(null, testDone);
            });
          });
        });
      });
    });
  });

  it("re-syncs a file that changed while it was being processed", function (testDone) {
    const Entry = require("models/entry");
    const path = this.fake.path(".txt");
    const blogID = this.blog.id;
    const original = Entry.set;
    let calls = 0;

    sync(blogID, function (err, folder, done) {
      if (err) return testDone.fail(err);

      spyOn(Entry, "set").and.callFake(function (blogID, entryPath, entry, cb) {
        // Change the source (and its size) after the first build read it
        if (++calls === 1)
          fs.outputFileSync(blogDirectory + path, "second version");
        original.call(Entry, blogID, entryPath, entry, cb);
      });

      fs.outputFileSync(blogDirectory + path, "first");

      folder.update(path, function (err, result) {
        if (err) return testDone.fail(err);
        expect(result.error).toBeNull();
        expect(calls).toBe(2);

        Entry.get(blogID, path, function (entry) {
          expect(entry.html).toContain("second version");
          done(null, testDone);
        });
      });
    });
  });

  it("does not re-sync a directory", function (testDone) {
    const dir = "/some-folder";
    const blogID = this.blog.id;

    sync(blogID, function (err, folder, done) {
      if (err) return testDone.fail(err);
      fs.ensureDirSync(blogDirectory + dir);

      // A build writing .preview.html files moves a directory's mtime. A
      // directory has no fingerprint, so this must not re-run the update.
      const touch = spyOn(build, "findMultiFolder").and.callFake(function () {
        const later = new Date(Date.now() + 5000 * touch.calls.count());
        fs.utimesSync(blogDirectory + dir, later, later);
        return null;
      });

      folder.update(dir, function (err, result) {
        if (err) return testDone.fail(err);
        expect(result.error).toBeNull();
        expect(touch.calls.count()).toBe(1);
        done(null, testDone);
      });
    });
  });

  it("ignores oversized sources, removes their entries, and recovers after shrinking", function (testDone) {
    const IgnoredFiles = require("models/ignoredFiles");
    const Entry = require("models/entry");
    const limit = require("build/converters/post-source-size").MARKDOWN.bytes;
    const entryPath = "/size-limit.md";
    const localPath = this.blogDirectory + entryPath;
    const blogID = this.blog.id;

    sync(blogID, function (err, folder, done) {
      if (err) return testDone.fail(err);
      fs.outputFileSync(localPath, "published");

      folder.update(entryPath, function (err) {
        if (err) return testDone.fail(err);
        fs.outputFileSync(localPath, Buffer.alloc(limit + 1, 32));

        folder.update(entryPath, function (err) {
          if (err) return testDone.fail(err);

          IgnoredFiles.getStatus(blogID, entryPath, function (err, reason) {
            if (err) return testDone.fail(err);
            expect(reason).toBe("TOO_LARGE");
            Entry.get(blogID, entryPath, function (entry) {
              // Entry.drop leaves a deleted tombstone rather than removing
              // the record outright.
              expect(entry).toBeTruthy();
              expect(entry.deleted).toBe(true);
              fs.outputFileSync(localPath, "published again");

              folder.update(entryPath, function (err) {
                if (err) return testDone.fail(err);
                IgnoredFiles.getStatus(blogID, entryPath, function (err, reason) {
                  if (err) return testDone.fail(err);
                  expect(reason).toBeFalsy();
                  Entry.get(blogID, entryPath, function (entry) {
                    expect(entry).toBeTruthy();
                    expect(entry.html).toContain("published again");
                    done(null, testDone);
                  });
                });
              });
            });
          });
        });
      });
    });
  });

  it("passes on a symlink in the way as an error, and builds nothing for it", function (testDone) {
    const os = require("os");
    const path = require("path");
    const Entry = require("models/entry");
    const blogID = this.blog.id;
    const blogDirectory = this.blogDirectory;
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "update-link-"));

    fs.outputFileSync(path.join(outside, "target.txt"), "Title: Linked");
    fs.ensureDirSync(blogDirectory);
    fs.symlinkSync(path.join(outside, "target.txt"), path.join(blogDirectory, "Link.txt"));

    sync(blogID, function (err, folder, done) {
      if (err) return testDone.fail(err);

      folder.update("/Link.txt", function (updateErr) {
        fs.removeSync(outside);
        expect(updateErr && updateErr.code).toBe("ELOOP");

        Entry.get(blogID, "/Link.txt", function (entry) {
          expect(entry).toBeFalsy();
          done(null, testDone);
        });
      });
    });
  });

  it("drops the entry of a file which is gone", function (testDone) {
    const Entry = require("models/entry");
    const blogID = this.blog.id;
    const entryPath = "/gone.txt";
    const localPath = this.blogDirectory + entryPath;

    sync(blogID, function (err, folder, done) {
      if (err) return testDone.fail(err);
      fs.outputFileSync(localPath, "Title: Gone");

      folder.update(entryPath, function (err) {
        if (err) return testDone.fail(err);
        fs.removeSync(localPath);

        folder.update(entryPath, function (err) {
          if (err) return testDone.fail(err);

          Entry.get(blogID, entryPath, function (entry) {
            expect(!entry || entry.deleted).toBeTruthy();
            done(null, testDone);
          });
        });
      });
    });
  });
});
