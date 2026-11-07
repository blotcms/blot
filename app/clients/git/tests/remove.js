describe("git client remove", function () {
  // Sets up a clean test blog (this.blog) for each test,
  // sets the blog's client to git (this.client), then creates
  // a test server with the git client's routes exposed, then
  // cleans everything up when each test has finished.
  require("./setup")();

  var remove = require("clients/git/remove");
  var write = require("clients/git/write");
  var context = require("clients/git/served/context");
  var removeRepo = require("clients/git/store/remove");
  var Git = require("./setup/git");
  var fs = require("fs-extra");

  it("should return an error if the store has no repository", async function () {
    await removeRepo({ store: context.objectStoreFor(this.blog.id) });

    var err = null;

    try {
      await remove(this.blog.id, "/path");
    } catch (e) {
      err = e;
    }

    expect(err.message).toContain("no copy");
  });

  it("does not error when removing a file that does not exist", async function () {
    await remove(this.blog.id, "/path");
  });

  it("removes a file", async function () {
    var repoDirectory = this.repoDirectory;
    var git = Git(repoDirectory).silent(true);
    var path = "/How/about That name.txt";
    var content = "Hello, world!";
    var blogID = this.blog.id;

    await write(blogID, path, content);
    await git.pull();

    expect(fs.readFileSync(repoDirectory + path, "utf-8")).toEqual(content);

    await remove(blogID, path);
    await git.pull();

    expect(fs.readdirSync(repoDirectory)).toEqual([".git"]);
  });
});
