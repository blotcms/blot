// What a push does to the rest of Blot, through the whole git client: the sync
// it starts (or doesn't), the follow-up written before the client is told
// "ok", and the lock on the refs it shares with Blot's own writes. The
// protocol itself is in served/tests/receive.js and store/tests/receive.js.
describe("git client push and the sync", function () {
  require("./setup")({ clone: false, client: true });

  var util = require("util");
  var client = require("models/client");
  var lock = require("helper/lock");
  var database = require("clients/git/database");
  var write = util.promisify(require("clients/git/write"));
  var helpers = require("./setup/helpers");

  var ALARM = "alarm:due:git-follow-up-sync";

  function sleep(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  // Every sync reads the applied commit before it does anything else
  function watchSyncs() {
    return spyOn(database, "getApplied").and.callThrough();
  }

  it("starts no sync for a push which is refused", async function () {
    var local = this.local;
    var syncs = watchSyncs();

    await local.git(["checkout", "--quiet", "-b", "feature"]);
    await local.commitFiles({ "/refused.txt": "Refused" });

    expect((await local.tryPush(["origin", "feature"])).code).not.toBe(0);

    await local.waitForSync();

    expect(syncs).not.toHaveBeenCalled();
    expect(await client.zScore(ALARM, this.blog.id)).toBe(null);
  });

  it("starts one sync for two pushes from the same base, and only the winner's", async function () {
    var local = this.local;
    var other = await local.cloneAgain();

    await local.writeAndPush("/first.txt", "First");
    await other.pull();
    await other.commitFiles({ "/other.txt": "Other" });
    await local.commitFiles({ "/second.txt": "Second" });

    var syncs = watchSyncs();
    var results = await Promise.all([local.tryPush(), other.tryPush()]);

    // One of them has to lose
    expect(
      results.filter(function (result) {
        return result.code === 0;
      }).length
    ).toBe(1);

    await local.waitForSync();

    expect(syncs.calls.count()).toBe(1);
    expect(await client.zScore(ALARM, this.blog.id)).toBe(null);
    expect([await local.head(), await other.head()]).toContain(
      await local.remoteHead()
    );
  });

  it("writes the follow-up before the client is told, and takes it back once synced", async function () {
    var local = this.local;
    var blogID = this.blog.id;
    var original = database.getApplied;
    var seen = [];

    spyOn(database, "getApplied").and.callFake(function () {
      // The sync is running, so the push has been acknowledged by now
      seen.push(client.zScore(ALARM, blogID));

      return original.apply(database, arguments);
    });

    await local.writeAndPush("/followed-up.txt", "Followed up");

    expect(
      (await Promise.all(seen)).map(function (score) {
        return score !== null;
      })
    ).toEqual([true]);
    expect(await client.zScore(ALARM, blogID)).toBe(null);
  });

  it("leaves a follow-up which was already waiting", async function () {
    var blogID = this.blog.id;
    var due = Date.now() + 60 * 60 * 1000;

    await client.zAdd(ALARM, { score: due, value: blogID });
    await this.local.commitFiles({ "/waiting.txt": "Waiting" });

    expect((await this.local.tryPush()).code).toBe(0);
    expect(await client.zScore(ALARM, blogID)).toBe(due);

    await client.zRem(ALARM, blogID);
    await this.local.waitForSync();
  });

  it("fails the push, and moves nothing, when the follow-up can't be written", async function () {
    var local = this.local;
    var syncs = watchSyncs();
    var before = await local.remoteHead();
    var multi = client.multi;

    // Only the follow-up is written with a transaction on the way to "ok"
    spyOn(client, "multi").and.callFake(function () {
      if (/helper\/alarm\.js/.test(new Error().stack))
        throw new Error("Redis is down");
      return multi.apply(client, arguments);
    });

    await local.commitFiles({ "/unrecorded.txt": "Unrecorded" });

    var refused = await local.tryPush();

    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain("could not record the push");
    expect(await local.remoteHead()).toBe(before);

    await local.waitForSync();

    expect(syncs).not.toHaveBeenCalled();
    expect(await helpers.blogHas(this, "/unrecorded.txt")).toBe(false);
  });

  it("makes Blot's own write wait while the refs are locked", async function () {
    var local = this.local;
    var held = await lock("blog:" + this.blog.id + ":git:ref-lock", {
      ttl: 10000,
      heartbeat: 3000,
    });
    var written = false;
    var writing = write(this.blog.id, "/from-blot.txt", "From Blot").then(
      function () {
        written = true;
      }
    );

    await sleep(1000);

    expect(written).toBe(false);
    expect(await local.remoteHead()).toBe(await local.head());

    await held.release();
    await writing;
    await local.pull();

    expect((await local.read("/from-blot.txt")).toString()).toBe("From Blot");
    expect(await local.head()).toBe(await local.remoteHead());
  });

  it("makes a user's push wait while the refs are locked, then applies it", async function () {
    var local = this.local;
    var held = await lock("blog:" + this.blog.id + ":git:ref-lock", {
      ttl: 10000,
      heartbeat: 3000,
    });
    var pushed = false;

    await local.commitFiles({ "/from-user.txt": "From the user" });

    var pushing = local.tryPush().then(function (result) {
      pushed = true;
      return result;
    });

    await sleep(1000);

    expect(pushed).toBe(false);
    expect(await local.remoteHead()).not.toBe(await local.head());

    await held.release();

    expect((await pushing).code).toBe(0);

    await local.waitForSync();

    expect(await helpers.blogFile(this, "/from-user.txt")).toEqual(
      Buffer.from("From the user")
    );
    await local.expectSynced();
  });

  it(
    "gives up with a message if the refs stay locked",
    async function () {
      var local = this.local;
      var held = await lock("blog:" + this.blog.id + ":git:ref-lock", {
        ttl: 30000,
        heartbeat: 10000,
      });

      await local.commitFiles({ "/locked-out.txt": "Locked out" });

      try {
        var refused = await local.tryPush();

        expect(refused.code).not.toBe(0);
        expect(refused.stderr).toContain(
          "another change to this repository is being applied"
        );
        expect(await local.remoteHead()).not.toBe(await local.head());
      } finally {
        await held.release();
      }
    },
    50 * 1000
  );
});
