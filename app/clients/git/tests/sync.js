describe("git client sync", function () {
  // Sets up a clean test blog (this.blog) for each test, sets the blog's
  // client to git, starts a test server with the git client's routes, and
  // clones the repository with a real git client (this.local, see
  // setup/client.js). Everything is cleaned up when each test has finished.
  //
  // These specs only look at what a user can observe: the git client talking
  // HTTP to the server, the blog folder's files, and the head the server
  // reports to `git ls-remote`. They do not open the repository on the
  // server's side, so they hold however the server stores it.
  require("./setup")({ clone: false, client: true });

  var fs = require("fs-extra");
  var helpers = require("./setup/helpers");

  // After every spec: the clone, the server's master and the blog folder
  // agree (the blog folder is compared with the clone's working tree, without
  // their .git directories)
  afterEach(async function () {
    await this.local.expectSynced();
  });

  function content(ctx) {
    return ctx.fake.file();
  }

  it("handles a new file", async function () {
    var path = helpers.randomPath(this.fake);
    var text = content(this);

    await this.local.writeAndPush(path, text);

    expect(await helpers.blogFile(this, path)).toEqual(Buffer.from(text));
  });

  it("handles updates to a file", async function () {
    var path = helpers.randomPath(this.fake);
    var changed = content(this) + "\nAn extra line";

    await this.local.writeAndPush(path, content(this));
    await this.local.writeAndPush(path, changed);

    expect(await helpers.blogFile(this, path)).toEqual(Buffer.from(changed));
  });

  it("handles a renamed file", async function () {
    var path = "/rename-me.txt";
    var newPath = "/new-rename-me.txt";
    var text = content(this);

    await this.local.writeAndPush(path, text);

    await fs.move(this.local.path(path), this.local.path(newPath));
    await this.local.commit("Rename the file");
    await this.local.push();

    expect(await helpers.blogHas(this, path)).toBe(false);
    expect(await helpers.blogFile(this, newPath)).toEqual(Buffer.from(text));
  });

  it("handles a removed file", async function () {
    // The folder comparison has trouble with nested paths since git does not
    // keep track of empty directories
    var path = "/" + this.fake.lorem.word() + ".txt";

    await this.local.writeAndPush(path, content(this));
    expect(await helpers.blogHas(this, path)).toBe(true);

    await this.local.remove(path);
    await this.local.commit("Remove the file");
    await this.local.push();

    expect(await helpers.blogHas(this, path)).toBe(false);
  });

  it("handles multiple commits pushed at once", async function () {
    var files = {};

    for (var i = 0; i < 3; i++)
      files["/commit-" + i + "/" + this.fake.lorem.word() + ".txt"] = content(this);

    for (var path of Object.keys(files)) {
      await this.local.commitFiles({ [path]: files[path] });
    }

    await this.local.push();

    for (var path of Object.keys(files)) {
      expect(await helpers.blogFile(this, path)).toEqual(Buffer.from(files[path]));
    }
  });

  it("handles two pushes during a single sync", async function () {
    var files = {};

    for (var i = 0; i < 10; i++) files["/first-push/" + i + ".txt"] = content(this);

    await this.local.commitFiles(files, "Ten files");

    // Does not wait for the sync of the first push
    var first = await this.local.tryPush();
    expect(first.code).toBe(0);

    await this.local.writeAndPush("/second-push.txt", content(this));

    expect(Object.keys(await helpers.blogFiles(this)).length).toBe(11);
  });

  it("resets any uncommitted changes in the server's blog folder", async function () {
    var path = "/Hello world.txt";
    var blogDirectory = this.blogDirectory;

    await this.local.writeAndPush(path, "Hello, World!");

    // This simulates an incorrect change to the blog's source folder made by
    // potentially buggy Blot code. This was NOT done by the client.
    fs.outputFileSync(blogDirectory + path, "Bad, World!");

    await this.local.writeAndPush(path, "Good, World!");

    expect(await helpers.blogFile(this, path)).toEqual(Buffer.from("Good, World!"));
  });

  it("handles a force push", async function () {
    var path = "/Hello world.txt";
    var local = this.local;
    var blogDirectory = this.blogDirectory;

    await local.writeAndPush(path, "Hello, World!");

    // Throw away the clone's history, start again from nothing and add the
    // remote. A push of this unrelated history is refused...
    await fs.remove(local.path(".git"));
    await local.git(["init", "--quiet", "--initial-branch", "master"]);
    await local.git(["remote", "add", "origin", local.url]);
    await local.commitFiles({ [path]: "Good, World!" });

    var refused = await local.tryPush(["--set-upstream", "origin", "master"]);

    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain("[rejected]");

    // ...and nothing changed on Blot's side
    expect(await helpers.blogFile(this, path)).toEqual(Buffer.from("Hello, World!"));

    // Spanner in the works! I was worried about this line in the git man
    // pages for rebase: "It is possible that a merge failure will prevent
    // this process from being completely automatic." So throw in a bad
    // change to the blog folder to see if Blot copes.
    fs.outputFileSync(blogDirectory + path, "Bad, World!");

    // ...until it is forced
    await local.push(["--force", "--set-upstream", "origin", "master"]);

    await local.writeAndPush("/other-path.txt", "other file");

    expect(await helpers.blogFile(this, path)).toEqual(Buffer.from("Good, World!"));
  });
});
