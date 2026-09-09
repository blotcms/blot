describe("update", function () {
  var sync = require("../index");
  var fs = require("fs-extra");

  // The "rebuilds an entry if the source file changes" spec below writes
  // the source file every 10ms for ~3 seconds while sync.update recurses
  // to catch up (see app/sync/update/index.js), so it can legitimately take
  // longer than Jasmine's 5 second default under load, causing an
  // intermittent timeout (and a stray late failure attributed to whichever
  // spec runs next).
  global.test.timeout(15 * 1000);

  // Set up a test blog before each test
  global.test.blog();

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

      fs.outputFileSync(folder.path + path, content.toString(), "utf-8");

      const poll = setInterval(function () {
        content = content + 1;
        console.log("setting content to", content.toString());
        fs.outputFileSync(folder.path + path, content.toString(), "utf-8");
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

      fs.outputFileSync(folder.path + path, content, "utf-8");
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

      fs.outputFileSync(folder.path + path, content, "utf-8");
      folder.update(path, function (err) {
        if (err) testDone.fail(err);

        checkEntry({ path: path, deleted: false }, function (err) {
          if (err) testDone.fail(err);

          fs.removeSync(folder.path + path);
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
});
