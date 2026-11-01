describe("write", function () {
  // Sets up a clean test blog (this.blog) for each test,
  // sets the blog's client to git (this.client), then creates
  // a test server with the git client's routes exposed, then
  // cleans everything up when each test has finished.
  require("./setup")();

  var write = require("clients/git/write");
  var Git = require("./setup/git");
  var fs = require("fs-extra");
  var localPath = require("helper/localPath");

  it("should return an error if there is no git repo in blog folder", function (done) {
    fs.removeSync(localPath(this.blog.id, ".git"));

    write(this.blog.id, "/path", "content", function (err) {
      expect(err.message).toContain("not");

      done();
    });
  });

  it("writes a file", function (done) {
    var repoDirectory = this.repoDirectory;
    var git = Git(repoDirectory).silent(true);
    var path = "/How/about That name.txt";
    var content = "Hello, world!";
    var blogID = this.blog.id;

    write(blogID, path, content, function (err) {
      if (err) return done.fail(err);

      git.pull(function (err) {
        if (err) return done.fail(err);

        expect(fs.readFileSync(repoDirectory + path, "utf-8")).toEqual(content);
        done();
      });
    });
  });

  it("writes a file with foreign characters", function (done) {
    var repoDirectory = this.repoDirectory;
    var git = Git(repoDirectory).silent(true);
    var path = "/こんにちは世界.txt";
    var content = "こんにちは世界!";
    var blogID = this.blog.id;

    write(blogID, path, content, function (err) {
      if (err) return done.fail(err);

      git.pull(function (err) {
        if (err) return done.fail(err);

        expect(fs.readFileSync(repoDirectory + path, "utf-8")).toEqual(content);
        done();
      });
    });
  });
});
