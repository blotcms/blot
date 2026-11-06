describe("git client create", function () {
  // Sets up a clean test blog (this.blog) for each test,
  // sets the blog's client to git (this.client), then creates
  // a test server with the git client's routes exposed, then
  // cleans everything up when each test has finished.
  require("./setup")({
    setClientToGit: false,
    clone: false,
  });

  var fs = require("fs-extra");
  var Express = require("express");
  var promisify = require("util").promisify;
  var Blog = require("models/blog");
  var repo = require("clients/git/repo");
  var create = require("clients/git/create");
  var disconnect = require("clients/git/disconnect");
  var Git = require("./setup/git");
  var folder = require("./setup/folder");
  var setClientToGit = require("./setup/setClientToGit");
  var inStore = promisify(repo.exists);

  // this prevents an existing repository from being clobbered
  it("should fail when the client has already been initialized", function (done) {
    var blog = this.blog;

    create(blog, function (err) {
      if (err) return done.fail(err);

      create(blog, async function (err) {
        try {
          expect(err.code).toEqual("EEXIST");
          expect(await inStore(blog.id)).toBe(true);
          expect(await folder.has(blog.id, "/.git")).toBe(false);
          done();
        } catch (e) {
          done.fail(e);
        }
      });
    });
  });

  it("refuses to set up a repository over the one the blog has", async function () {
    var blog = this.blog;
    var messages = [];

    await promisify(create)(blog);

    var server = Express()
      .use(function (req, res, next) {
        req.blog = blog;
        req.body = {};
        res.message = function (url, message) {
          messages.push(message);
          res.sendStatus(200);
        };
        next();
      })
      .use(require("clients/git/routes").dashboard);

    await new Promise(function (resolve) {
      server = server.listen(0, resolve);
    });

    await fetch("http://127.0.0.1:" + server.address().port + "/create", {
      method: "POST",
    });

    await new Promise(function (resolve) {
      server.close(resolve);
    });

    var latest = await promisify(Blog.get)({ id: blog.id });

    expect(messages.length).toBe(1);
    expect(latest.client).not.toBe("git");
    expect(await inStore(blog.id)).toBe(true);
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

  it("should fail when there is a repo with an origin in the blog's folder", async function () {
    var blog = this.blog;

    await folder.write(blog.id, "/.git/HEAD", "ref: refs/heads/master\n");
    await folder.write(
      blog.id,
      "/.git/config",
      '[remote "origin"]\n\turl = http://git.com/foo.git\n'
    );

    var err = await promisify(create)(blog).then(
      () => null,
      (err) => err
    );

    expect(err).toEqual(jasmine.any(Error));
    expect(await inStore(blog.id)).toBe(false);
    // It isn't one this create made
    expect(await folder.has(blog.id, "/.git/config")).toBe(true);
  });

  it("preserves existing files and folders", async function () {
    var blog = this.blog;
    var clonedDir = this.tmp + "/" + this.blog.handle;

    await folder.write(blog.id, "/first.txt", "Hello");
    await folder.write(blog.id, "/Sub Folder/second.txt", "World");
    await folder.write(blog.id, "/third", "!");

    var repoUrl = await promisify(setClientToGit)(
      this.user,
      blog,
      this.server.port
    );
    await Git(this.tmp).silent(true).clone(repoUrl);

    // Blot's copy of the blog folder
    expect(await folder.names(blog.id, "/")).toEqual([
      "Sub Folder",
      "first.txt",
      "third",
    ]);
    expect(await folder.names(blog.id, "/Sub Folder")).toEqual(["second.txt"]);

    // The clone
    expect(fs.readdirSync(clonedDir).sort()).toEqual([
      ".git",
      "Sub Folder",
      "first.txt",
      "third",
    ]);
    expect(fs.readdirSync(clonedDir + "/Sub Folder")).toEqual(["second.txt"]);
  });

  // Blot cannot tell a placeholder (an empty file standing in for a file it
  // could not download) from a file that really is empty, so neither is added.
  it("does not add empty files to the repository", async function () {
    var blog = this.blog;
    var clonedDir = this.tmp + "/" + this.blog.handle;

    await folder.write(blog.id, "/post.txt", "Hello");
    await folder.write(blog.id, "/placeholder.pdf", "");

    var repoUrl = await promisify(setClientToGit)(
      this.user,
      blog,
      this.server.port
    );
    await Git(this.tmp).silent(true).clone(repoUrl);

    expect(fs.readdirSync(clonedDir).sort()).toEqual([".git", "post.txt"]);
    // The placeholder stays in the blog folder
    expect(await folder.has(blog.id, "/placeholder.pdf")).toBe(true);
  });

  it("skips files ignored by an existing .gitignore", async function () {
    var blog = this.blog;
    var clonedDir = this.tmp + "/" + this.blog.handle;

    await folder.write(blog.id, "/.gitignore", ".verification/\n");
    await folder.write(blog.id, "/post.txt", "Hello");
    await folder.write(blog.id, "/.verification/agent.jsonl", "notes");

    var repoUrl = await promisify(setClientToGit)(
      this.user,
      blog,
      this.server.port
    );
    await Git(this.tmp).silent(true).clone(repoUrl);

    expect(await folder.names(blog.id, "/")).toEqual([
      ".gitignore",
      ".verification",
      "post.txt",
    ]);
    expect(await folder.has(blog.id, "/.verification/agent.jsonl")).toBe(true);

    expect(fs.readdirSync(clonedDir).sort()).toEqual([
      ".git",
      ".gitignore",
      "post.txt",
    ]);
    expect(fs.existsSync(clonedDir + "/.verification")).toBe(false);
  });
});
