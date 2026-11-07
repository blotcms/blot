// IMPLEMENTATION-SPECIFIC. The commit that Blot last applied to a blog's
// entries is recorded in Redis, and the next sync diffs from it (#2259). It is
// not something a user can see, but it is what makes a sync that was
// interrupted catch up, so it is pinned here with a real git client.
// sync-redis-unavailable.js covers the same with git and Redis faked.
describe("git client: the last applied commit", function () {
  require("./setup")({ clone: false, client: true });

  var util = require("util");
  var database = require("clients/git/database");
  var Entry = require("models/entry");
  var disconnect = util.promisify(require("clients/git/disconnect"));
  var sync = require("clients/git/sync");
  var write = require("clients/git/write");
  var helpers = require("./setup/helpers");

  var getApplied = database.getApplied;
  var setApplied = database.setApplied;
  var removeApplied = database.removeApplied;

  var NOT_A_COMMIT = "0123456789012345678901234567890123456789";

  it("is the commit of the last push once it has synced", async function () {
    await this.local.writeAndPush("/first.txt", "First");

    expect(await getApplied(this.blog.id)).toBe(await this.local.remoteHead());

    await this.local.writeAndPush("/second.txt", "Second");

    expect(await getApplied(this.blog.id)).toBe(await this.local.remoteHead());
  });

  it("applies a push again if the sync did not get to record it", async function () {
    var before = await this.local.remoteHead();

    await this.local.writeAndPush("/interrupted.txt", "Interrupted");

    // As if the sync stopped after moving the blog folder to the new commit,
    // and before the entry was saved
    await setApplied(this.blog.id, before);
    await Entry.drop(this.blog.id, "/interrupted.txt");
    expect(
      (await helpers.entry(this.blog.id, "/interrupted.txt")).deleted
    ).toBe(true);

    await sync(this.blog.id, this.blog.handle);

    expect(
      (await helpers.entry(this.blog.id, "/interrupted.txt")).deleted
    ).toBe(false);
    expect(await getApplied(this.blog.id)).toBe(await this.local.remoteHead());
  });

  it("is set by the next sync if there is none", async function () {
    await this.local.writeAndPush("/before.txt", "Before");
    await removeApplied(this.blog.id);

    await this.local.writeAndPush("/after.txt", "After");

    expect((await helpers.entry(this.blog.id, "/after.txt")).deleted).toBe(
      false
    );
    expect(await getApplied(this.blog.id)).toBe(await this.local.remoteHead());
  });

  it("is replaced if it is a commit the repository does not have", async function () {
    await setApplied(this.blog.id, NOT_A_COMMIT);

    await this.local.writeAndPush("/after.txt", "After");

    expect((await helpers.entry(this.blog.id, "/after.txt")).deleted).toBe(
      false
    );
    expect(await getApplied(this.blog.id)).toBe(await this.local.remoteHead());
  });

  it("moves to Blot's own commit when it was the commit before", async function () {
    await this.local.writeAndPush("/pushed.txt", "Pushed");
    await write(this.blog.id, "/by-blot.txt", "By Blot");

    expect(await getApplied(this.blog.id)).toBe(await this.local.remoteHead());
  });

  it("stays where it is when Blot commits on top of something else", async function () {
    await this.local.writeAndPush("/pushed.txt", "Pushed");
    await setApplied(this.blog.id, NOT_A_COMMIT);
    await write(this.blog.id, "/by-blot.txt", "By Blot");

    expect(await getApplied(this.blog.id)).toBe(NOT_A_COMMIT);

    // and the next sync catches up
    await this.local.pull();
    await this.local.writeAndPush("/later.txt", "Later");

    expect(await getApplied(this.blog.id)).toBe(await this.local.remoteHead());
  });

  it("is forgotten when the blog is disconnected", async function () {
    await this.local.writeAndPush("/pushed.txt", "Pushed");
    expect(await getApplied(this.blog.id)).toEqual(jasmine.any(String));

    await disconnect(this.blog.id);

    expect(await getApplied(this.blog.id)).toBe(null);
  });
});
