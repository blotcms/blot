describe("git client create", function () {
  // Sets up a clean test blog (this.blog) for each test,
  // sets the blog's client to git (this.client), then creates
  // a test server with the git client's routes exposed, then
  // cleans everything up when each test has finished.
  require("./setup")({
    setClientToGit: false,
    clone: false,
  });

  var create = require("clients/git/create");
  var disconnect = require("clients/git/disconnect");
  var Git = require("simple-git");
  var localPath = require("helper/localPath");
  var setClientToGit = require("./setup/setClientToGit");

  // this prevents an existing bare repo from being clobbered
  it("should fail when the client has already been initialized", function (done) {
    var blog = this.blog;

    create(blog, function (err) {
      if (err) return done.fail(err);

      create(blog, function (err) {
        expect(err.code).toEqual("EEXIST");
        done();
      });
    });
  });

  // this prevents an existing bare repo from being clobbered
  // this simulates a user connecting the git client, disconnecting
  // then connecting again..
  it("should not fail when disconnect is called in between", function (done) {
    var blog = this.blog;

    create(blog, function (err) {
      if (err) return done.fail(err);

      disconnect(blog.id, function (err) {
        if (err) return done.fail(err);

        create(blog, function (err) {
          if (err) return done.fail(err);

          done();
        });
      });
    });
  });

  it("should fail when there is a repo with an origin in the blog's folder", function (done) {
    var Git = require("simple-git");
    var blog = this.blog;

    Git = Git(localPath(blog.id, "/")).silent(true);

    Git.init(function (err) {
      if (err) return done.fail(err);

      Git.addRemote("origin", "http://git.com/foo.git", function (err) {
        if (err) return done.fail(err);
        create(blog, function (err) {
          expect(err).not.toEqual(null);
          expect(err).toEqual(jasmine.any(Error));

          done();
        });
      });
    });
  });

  it("preserves existing files and folders", function (done) {
    var blogDir = localPath(this.blog.id, "/");
    var fs = require("fs-extra");
    var blog = this.blog;
    var tmp = this.tmp;
    var clonedDir = this.tmp + "/" + this.blog.handle;

    fs.outputFileSync(blogDir + "/first.txt", "Hello");
    fs.outputFileSync(blogDir + "/Sub Folder/second.txt", "World");
    fs.outputFileSync(blogDir + "/third", "!");

    setClientToGit(this.user, blog, this.server.port, function (err, repoUrl) {
      if (err) return done.fail(err);

      Git(tmp)
        .silent(true)
        .clone(repoUrl, function (err) {
          if (err) return done.fail(err);

          // Verify files and folders are preserved in Blot's copy of blog folder
          expect(fs.readdirSync(blogDir)).toEqual([
            ".git",
            "Sub Folder",
            "first.txt",
            "third",
          ]);
          expect(fs.readdirSync(blogDir + "/Sub Folder")).toEqual([
            "second.txt",
          ]);

          // Verify files and folders are preserved in cloneable folder
          expect(fs.readdirSync(clonedDir)).toEqual([
            ".git",
            "Sub Folder",
            "first.txt",
            "third",
          ]);
          expect(fs.readdirSync(clonedDir + "/Sub Folder")).toEqual([
            "second.txt",
          ]);

          done();
        });
    });
  });

  it("skips files ignored by an existing .gitignore", function (done) {
    var blogDir = localPath(this.blog.id, "/");
    var fs = require("fs-extra");
    var blog = this.blog;
    var tmp = this.tmp;
    var clonedDir = this.tmp + "/" + this.blog.handle;

    fs.outputFileSync(blogDir + "/.gitignore", ".verification/\n");
    fs.outputFileSync(blogDir + "/post.txt", "Hello");
    fs.outputFileSync(blogDir + "/.verification/agent.jsonl", "notes");

    setClientToGit(this.user, blog, this.server.port, function (err, repoUrl) {
      if (err) return done.fail(err);

      Git(tmp)
        .silent(true)
        .clone(repoUrl, function (err) {
          if (err) return done.fail(err);

          expect(fs.readdirSync(blogDir).sort()).toEqual([
            ".git",
            ".gitignore",
            ".verification",
            "post.txt",
          ]);
          expect(fs.existsSync(blogDir + "/.verification/agent.jsonl")).toBe(
            true
          );

          expect(fs.readdirSync(clonedDir).sort()).toEqual([
            ".git",
            ".gitignore",
            "post.txt",
          ]);
          expect(fs.existsSync(clonedDir + "/.verification")).toBe(false);

          done();
        });
    });
  });
});
