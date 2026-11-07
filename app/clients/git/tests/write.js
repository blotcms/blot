describe("write", function () {
  // Sets up a clean test blog (this.blog) for each test,
  // sets the blog's client to git (this.client), then creates
  // a test server with the git client's routes exposed, then
  // cleans everything up when each test has finished.
  require("./setup")();

  var write = require("clients/git/write");
  var repo = require("clients/git/repo");
  var context = require("clients/git/served/context");
  var removeRepo = require("clients/git/store/remove");
  var Git = require("./setup/git");
  var fs = require("fs-extra");
  var folder = require("./setup/folder");

  it("should return an error if the store has no repository, and leave the blog folder alone", async function () {
    var blogID = this.blog.id;

    await removeRepo({ store: context.objectStoreFor(blogID) });

    var err = null;

    try {
      await write(blogID, "/path", "content");
    } catch (e) {
      err = e;
    }

    expect(err.message).toContain("no copy");
    expect(await folder.has(blogID, "/path")).toBe(false);
  });

  it("should return an error for a path it cannot commit, and leave the blog folder alone", async function () {
    var blogID = this.blog.id;

    var err = null;

    try {
      await repo.commit(blogID, {
        path: "/x/.Git/config",
        contents: "content",
      });
    } catch (e) {
      err = e;
    }

    expect(err).toEqual(jasmine.any(Error));
    expect(await folder.has(blogID, "/x")).toBe(false);

    err = null;

    try {
      await write(blogID, "/a/../b", "content");
    } catch (e) {
      err = e;
    }

    expect(err).toEqual(jasmine.any(Error));
    expect(await folder.has(blogID, "/b")).toBe(false);
  });

  it("rejects without a callback for an ignored file or a path it cannot commit", async function () {
    var blogID = this.blog.id;
    var rejections = [];

    for (var attempt of [
      () => write(blogID, "/.DS_Store", "content"),
      () => repo.commit(blogID, { path: "/x/.Git/config", contents: "c" }),
    ]) {
      try {
        await attempt();
      } catch (err) {
        rejections.push(err);
      }
    }

    expect(rejections.length).toBe(2);
    expect(rejections[0].message).toContain("Cannot write ignored file");
    expect(await repo.exists(blogID)).toBe(true);
  });

  it("writes a file", async function () {
    var repoDirectory = this.repoDirectory;
    var git = Git(repoDirectory).silent(true);
    var path = "/How/about That name.txt";
    var content = "Hello, world!";
    var blogID = this.blog.id;

    await write(blogID, path, content);
    await git.pull();

    expect(fs.readFileSync(repoDirectory + path, "utf-8")).toEqual(content);
  });

  it("writes a file with foreign characters", async function () {
    var repoDirectory = this.repoDirectory;
    var git = Git(repoDirectory).silent(true);
    var path = "/こんにちは世界.txt";
    var content = "こんにちは世界!";
    var blogID = this.blog.id;

    await write(blogID, path, content);
    await git.pull();

    expect(fs.readFileSync(repoDirectory + path, "utf-8")).toEqual(content);
  });
});
