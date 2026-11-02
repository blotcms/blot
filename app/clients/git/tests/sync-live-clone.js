// IMPLEMENTATION-SPECIFIC. A blog may have a live clone, the second copy of
// the repository which the git client kept in the blog folder's .git directory
// until Blot's writes stopped being made in it (#2259 PR 8), and a blog made
// since never has one. A sync does not need it, keeps it at the new commit when
// it is there, and must not be put off by one left behind master (as it is
// after this code is rolled back). Delete this file when the live clones go
// (PR 9).
describe("git client sync (implementation-specific: the live clone)", function () {
  require("./setup")({ clone: false, client: true });

  var fs = require("fs-extra");
  var helpers = require("./setup/helpers");
  var liveClone = require("./setup/liveClone");

  async function cloneHead(git) {
    return (await git.raw(["rev-parse", "HEAD"])).trim();
  }

  it("syncs a blog which has no live clone, and makes none", async function () {
    expect(await fs.pathExists(this.blogDirectory + "/.git")).toBe(false);

    await this.local.writeAndPush("/pushed.txt", "Pushed");
    await this.local.writeAndPush("/pushed.txt", "Pushed again");

    expect(await helpers.blogFile(this, "/pushed.txt")).toEqual(Buffer.from("Pushed again"));
    expect(await fs.pathExists(this.blogDirectory + "/.git")).toBe(false);

    await this.local.expectSynced();
  });

  it("keeps the live clone at the new commit", async function () {
    var git = await liveClone(this);

    await this.local.writeAndPush("/pushed.txt", "Pushed");

    expect(await cloneHead(git)).toBe(await this.local.remoteHead());
    expect(await helpers.blogFile(this, "/pushed.txt")).toEqual(Buffer.from("Pushed"));
  });

  it("starts no gc or maintenance in the live clone when it fetches", async function () {
    var git = await liveClone(this);

    // Every fetch keeps its own pack, and more than one pack is over gc's
    // limit, so a fetch which started gc (in the foreground here) would have
    // repacked them into one before it returned
    await git.raw(["config", "fetch.unpackLimit", "1"]);
    await git.raw(["config", "gc.autoPackLimit", "1"]);
    await git.raw(["config", "gc.autoDetach", "false"]);
    await git.raw(["config", "maintenance.autoDetach", "false"]);

    async function packs() {
      var output = await git.raw(["count-objects", "-v"]);
      return Number(/^packs: (\d+)$/m.exec(output)[1]);
    }

    var before = await packs();

    await this.local.writeAndPush("/pushed.txt", "Pushed");
    await this.local.writeAndPush("/pushed.txt", "Pushed again");

    expect(await cloneHead(git)).toBe(await this.local.remoteHead());

    // At least one new pack per push's fetch, none merged
    expect(await packs()).toBeGreaterThanOrEqual(before + 2);
    expect(await fs.pathExists(this.blogDirectory + "/.git/objects/info/commit-graph")).toBe(false);
    expect(await fs.pathExists(this.blogDirectory + "/.git/objects/info/commit-graphs")).toBe(false);
  });

  it("syncs when the live clone is behind master", async function () {
    var git = await liveClone(this);
    var first = await cloneHead(git);

    await this.local.writeAndPush("/one.txt", "One");

    // As it is after a rollback in which Blot's writes moved master and the
    // clone was not
    await git.raw(["reset", "--quiet", "--mixed", first]);

    await this.local.writeAndPush("/two.txt", "Two");

    expect(await cloneHead(git)).toBe(await this.local.remoteHead());
    expect(await helpers.blogFile(this, "/one.txt")).toEqual(Buffer.from("One"));
    expect(await helpers.blogFile(this, "/two.txt")).toEqual(Buffer.from("Two"));

    await this.local.expectSynced();
  });

  it("syncs when the live clone has no commits", async function () {
    var Git = require("clients/git/git");
    var path = require("path");

    await Git(this.blogDirectory, {
      env: { GIT_CEILING_DIRECTORIES: path.dirname(this.blogDirectory) },
    }).raw(["init", "--quiet", "--initial-branch=master"]);

    await this.local.writeAndPush("/pushed.txt", "Pushed");

    expect(await helpers.blogFile(this, "/pushed.txt")).toEqual(Buffer.from("Pushed"));
    await this.local.expectSynced();
  });
});
