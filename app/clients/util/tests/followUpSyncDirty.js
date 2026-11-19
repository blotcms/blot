// A webhook that finds the blog's folder lock held marks the blog dirty, and
// the sync that holds the lock runs again as soon as it has finished.
describe("followUpSync dirty flag", function () {
  const { randomUUID } = require("crypto");
  const client = require("models/client");
  const folderLock = require("sync/lock");
  const followUpSync = require("../followUpSync");

  let name, blogID, held;

  const dirtyKey = () => "sync:follow-up:dirty:" + name + ":" + blogID;

  beforeEach(function () {
    name = "test-" + randomUUID();
    blogID = "blog_" + randomUUID();
    held = null;
    spyOn(console, "log");
  });

  afterEach(async function () {
    if (held) await held.release();
    await client.del([
      dirtyKey(),
      "alarm:due:" + name + "-follow-up-sync",
      "alarm:claims:" + name + "-follow-up-sync",
    ]);
  });

  it("sets the dirty flag with a TTL, and the alarm, when the lock is held", async function () {
    const syncBlog = jasmine.createSpy("syncBlog");
    const followUps = followUpSync(name, syncBlog);

    held = await folderLock.lock(blogID, { ttl: 10000, heartbeat: 3000 });
    await followUps.run(blogID);

    expect(syncBlog).not.toHaveBeenCalled();
    expect(await client.get(dirtyKey())).toBe("1");
    const ttl = await client.ttl(dirtyKey());
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(300);
    expect(await followUps.alarm.when(blogID)).not.toBe(null);
  });

  it("syncs again straight away when a webhook arrived during the sync", async function () {
    let syncs = 0;
    let followUps;
    const syncBlog = jasmine.createSpy("syncBlog").and.callFake(async () => {
      syncs++;
      if (syncs === 1) {
        // A webhook arrives while the first sync holds the lock
        const lock = await folderLock.lock(blogID, {
          ttl: 10000,
          heartbeat: 3000,
        });
        await followUps.run(blogID);
        await lock.release();
      }
    });
    followUps = followUpSync(name, syncBlog);

    await followUps.run(blogID);

    expect(syncBlog.calls.count()).toBe(2);
    expect(await client.get(dirtyKey())).toBe(null);
    expect(await followUps.alarm.when(blogID)).toBe(null);
  });

  it("does not sync again when nothing arrived during the sync", async function () {
    const syncBlog = jasmine
      .createSpy("syncBlog")
      .and.returnValue(Promise.resolve());
    const followUps = followUpSync(name, syncBlog);

    await followUps.run(blogID);

    expect(syncBlog.calls.count()).toBe(1);
  });

  it("leaves an existing follow-up alone when a sync finds no dirty flag", async function () {
    const syncBlog = jasmine
      .createSpy("syncBlog")
      .and.returnValue(Promise.resolve());
    const followUps = followUpSync(name, syncBlog);

    // Armed by another process for a change it has not synced yet
    const armed = await followUps.arm(blogID);
    expect(armed).toBeDefined();

    await followUps.run(blogID);

    expect(syncBlog.calls.count()).toBe(1);
    expect(await followUps.alarm.when(blogID)).toBe(armed);
  });

  it("caps the repeats and leaves the rest to the follow-up alarm", async function () {
    let followUps;
    const syncBlog = jasmine.createSpy("syncBlog").and.callFake(async () => {
      // Every sync has another webhook arrive during it
      const lock = await folderLock.lock(blogID, {
        ttl: 10000,
        heartbeat: 3000,
      });
      await followUps.run(blogID);
      await lock.release();
    });
    followUps = followUpSync(name, syncBlog);

    await followUps.run(blogID);

    // The first sync and five repeats
    expect(syncBlog.calls.count()).toBe(6);
    expect(await followUps.alarm.when(blogID)).not.toBe(null);
  });
});
