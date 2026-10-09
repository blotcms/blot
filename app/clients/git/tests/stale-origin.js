describe("git client write and remove with a stale origin", function () {
  // Sets up a clean test blog (this.blog) for each test,
  // sets the blog's client to git (this.client), then creates
  // a test server with the git client's routes exposed, then
  // cleans everything up when each test has finished.
  require("./setup")();

  var write = require("clients/git/write");
  var remove = require("clients/git/remove");
  var dataDir = require("clients/git/dataDir");

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
});
