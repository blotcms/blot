describe("git client write and remove with a stale origin", function () {
  // Sets up a clean test blog (this.blog) for each test,
  // sets the blog's client to git (this.client), then creates
  // a test server with the git client's routes exposed, then
  // cleans everything up when each test has finished.
  require("./setup")();

  var write = require("clients/git/write");
  var remove = require("clients/git/remove");
  var dataDir = require("clients/git/dataDir");
  var bareRepo = require("clients/git/bareRepo");
  var Blog = require("models/blog");
  var localPath = require("helper/localPath");
  var fs = require("fs-extra");

  function listFiles(git, callback) {
    git.raw(["ls-tree", "-r", "--name-only", "master"], function (err, out) {
      if (err) return callback(new Error(err));
      callback(null, out.split("\n").filter(Boolean));
    });
  }

  function originURL(git, callback) {
    git.raw(["remote", "get-url", "origin"], function (err, out) {
      if (err) return callback(new Error(err));
      callback(null, out.trim());
    });
  }

  it("pushes writes and removals to the bare repo and fixes origin", function (done) {
    var gitBlot = this.gitBlot;
    var gitBare = this.gitBare;
    var blogID = this.blog.id;
    var bareDirectory = dataDir + "/" + this.blog.handle + ".git";
    var path = "/Stale origin.txt";

    gitBlot.raw(
      ["remote", "set-url", "origin", "/nonexistent/x.git"],
      function (err) {
        if (err) return done.fail(new Error(err));

        write(blogID, path, "Hello, world!", function (err) {
          if (err) return done.fail(err);

          listFiles(gitBare, function (err, files) {
            if (err) return done.fail(err);

            expect(files).toContain("Stale origin.txt");

            originURL(gitBlot, function (err, url) {
              if (err) return done.fail(err);

              expect(url).toEqual(bareDirectory);

              gitBlot.raw(
                ["remote", "set-url", "origin", "/nonexistent/x.git"],
                function (err) {
                  if (err) return done.fail(new Error(err));

                  remove(blogID, path, function (err) {
                    if (err) return done.fail(err);

                    listFiles(gitBare, function (err, files) {
                      if (err) return done.fail(err);

                      expect(files).not.toContain("Stale origin.txt");

                      originURL(gitBlot, function (err, url) {
                        if (err) return done.fail(err);

                        expect(url).toEqual(bareDirectory);
                        done();
                      });
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

  it("leaves origin unchanged if the target bare repo does not exist", function (done) {
    var gitBlot = this.gitBlot;
    var oldURL = "/nonexistent/old-location.git";

    gitBlot.raw(["remote", "set-url", "origin", oldURL], function (err) {
      if (err) return done.fail(new Error(err));

      bareRepo.pointOriginAtBareRepo(
        gitBlot,
        "handle-without-a-bare-repo",
        function (err) {
          expect(err).toBeNull();

          originURL(gitBlot, function (err, url) {
            if (err) return done.fail(err);

            expect(url).toEqual(oldURL);
            done();
          });
        }
      );
    });
  });

  it("does not modify the blog folder if the origin lookup fails", function (done) {
    var blogID = this.blog.id;
    var path = "/Lookup fails.txt";
    var existingPath = "/Existing file.txt";
    var originalGet = Blog.get;

    // Restored by hand (rather than with a spy) so the setup's
    // afterEach hooks, which also use Blog.get, see the real thing
    function failLookups() {
      Blog.get = function (query, callback) {
        callback(new Error("redis down"));
      };
    }

    function restoreLookups() {
      Blog.get = originalGet;
    }

    // Start with a tracked file, so we can check remove leaves it alone
    write(blogID, existingPath, "Hello, world!", function (err) {
      if (err) return done.fail(err);

      failLookups();

      write(blogID, path, "Should not be written", function (err) {
        restoreLookups();

        expect(err).toEqual(jasmine.any(Error));
        expect(err.message).toEqual("redis down");
        expect(fs.existsSync(localPath(blogID, path))).toBe(false);

        failLookups();

        remove(blogID, existingPath, function (err) {
          restoreLookups();

          expect(err).toEqual(jasmine.any(Error));
          expect(err.message).toEqual("redis down");
          expect(
            fs.readFileSync(localPath(blogID, existingPath), "utf8")
          ).toEqual("Hello, world!");
          done();
        });
      });
    });
  });
});
