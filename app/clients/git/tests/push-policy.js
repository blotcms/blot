// Which pushes the server refuses, as a real git client sees it. Part of the
// regression suite for the git client (#2259). The pushes which are accepted
// today but which the rewrite deliberately refuses are in
// current-behaviour-2259-changes.js.
describe("git client push policy", function () {
  require("./setup")({ clone: false, client: true });

  var helpers = require("./setup/helpers");

  afterEach(async function () {
    // Nothing a refused push sent reached the blog
    await this.local.expectSynced();
  });

  it("rejects a push to a branch other than master", async function () {
    var local = this.local;
    var path = "/on-a-branch.txt";

    await local.git(["checkout", "--quiet", "-b", "feature/branch-check"]);
    await local.commitFiles({ [path]: "Committed on a branch" });

    var refused = await local.tryPush(["origin", "feature/branch-check"]);

    expect(refused.code).not.toBe(0);
    // Git shows the server's HTTP status or its message, depending on how the
    // server refuses, so accept either
    expect(refused.stderr).toMatch(/HTTP 400|only the master branch/i);

    expect(await local.remoteHead("feature/branch-check")).toBeNull();
    expect(await helpers.blogHas(this, path)).toBe(false);

    // Back on master, which was not touched
    await local.git(["checkout", "--quiet", "master"]);
  });

  it("rejects deleting master", async function () {
    var local = this.local;

    await local.writeAndPush("/stays.txt", "Still here after the refused deletion");

    var refused = await local.tryPush(["origin", ":master"]);

    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain("master");
    expect(await local.remoteHead()).toBe(await local.head());
    expect(await helpers.blogHas(this, "/stays.txt")).toBe(true);
  });

  it("accepts a push to master after a refused one", async function () {
    var local = this.local;

    await local.git(["checkout", "--quiet", "-b", "other"]);
    await local.commitFiles({ "/refused.txt": "Refused" });

    expect((await local.tryPush(["origin", "other"])).code).not.toBe(0);

    await local.git(["checkout", "--quiet", "master"]);
    await local.writeAndPush("/accepted.txt", "Accepted");

    expect(await helpers.blogHas(this, "/accepted.txt")).toBe(true);
    expect(await helpers.blogHas(this, "/refused.txt")).toBe(false);
  });
});
