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
});
