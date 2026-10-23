// A webhook for a blog that is already syncing leaves one follow-up in Redis,
// which any process runs once the folder lock is free.
describe("followUpSync", function () {
  const { randomUUID } = require("crypto");
  const client = require("models/client");
  const folderLock = require("sync/lock");
  const followUpSync = require("../followUpSync");

  const lockedError = () => new Error("Failed to acquire folder lock");

  let name, blogID, held;

  beforeEach(function () {
    name = "test-" + randomUUID();
    blogID = "blog_" + randomUUID();
    held = null;
    spyOn(console, "log");
  });

  afterEach(async function () {
    if (held) await held.release();
    await client.del([
      "alarm:due:" + name + "-follow-up-sync",
      "alarm:claims:" + name + "-follow-up-sync",
    ]);
  });

  const holdLock = async () => {
    held = await folderLock.lock(blogID, { ttl: 10000, heartbeat: 3000 });
  };

  const releaseLock = async () => {
    await held.release();
    held = null;
  };

  // Follow-ups wait RETRY_MS; bring this one forward so a poll runs it now
  const makeDue = (followUps) => followUps.alarm.set(blogID, Date.now());

  it("syncs straight away when no sync is running", async function () {
    const syncBlog = jasmine.createSpy("syncBlog").and.returnValue(Promise.resolve());
    const followUps = followUpSync(name, syncBlog);

    await followUps.run(blogID);

    expect(syncBlog.calls.allArgs()).toEqual([[blogID]]);
    expect(await followUps.alarm.when(blogID)).toBe(null);
  });

  it("collapses requests during a running sync into one follow-up, run once the lock is free", async function () {
    const syncBlog = jasmine.createSpy("syncBlog").and.returnValue(Promise.resolve());
    const followUps = followUpSync(name, syncBlog);

    await holdLock();
    await followUps.run(blogID);
    await followUps.run(blogID);
    await followUps.run(blogID);

    expect(syncBlog).not.toHaveBeenCalled();
    expect(await followUps.alarm.when(blogID)).not.toBe(null);

    await releaseLock();
    await makeDue(followUps);
    expect(await followUps.alarm.poll()).toBe(1);

    expect(syncBlog.calls.allArgs()).toEqual([[blogID]]);
    expect(await followUps.alarm.when(blogID)).toBe(null);
  });

  it("is run by another instance, as by another process", async function () {
    const here = jasmine.createSpy("here").and.returnValue(Promise.resolve());
    const there = jasmine.createSpy("there").and.returnValue(Promise.resolve());
    const followUps = followUpSync(name, here);
    const elsewhere = followUpSync(name, there);

    await holdLock();
    await followUps.run(blogID);
    await releaseLock();
    await makeDue(followUps);

    expect(await elsewhere.alarm.poll()).toBe(1);
    expect(here).not.toHaveBeenCalled();
    expect(there.calls.allArgs()).toEqual([[blogID]]);
  });

  it("queues a follow-up when the sync itself finds the lock taken", async function () {
    const syncBlog = jasmine.createSpy("syncBlog").and.callFake(() => Promise.reject(lockedError()));
    const followUps = followUpSync(name, syncBlog);

    await followUps.run(blogID);

    expect(syncBlog).toHaveBeenCalledTimes(1);
    expect(await followUps.alarm.when(blogID)).not.toBe(null);
  });

  it("re-queues a follow-up whose sync finds the lock taken again", async function () {
    const syncBlog = jasmine.createSpy("syncBlog").and.callFake(() => Promise.reject(lockedError()));
    const followUps = followUpSync(name, syncBlog);

    await makeDue(followUps);
    await followUps.alarm.poll();

    expect(syncBlog).toHaveBeenCalledTimes(1);
    expect(await followUps.alarm.when(blogID)).toBeGreaterThan(Date.now());
  });

  it("logs other sync errors without retrying", async function () {
    const syncBlog = jasmine.createSpy("syncBlog").and.callFake(() => Promise.reject(new Error("boom")));
    const followUps = followUpSync(name, syncBlog);

    await followUps.run(blogID);
    expect(await followUps.alarm.when(blogID)).toBe(null);

    await makeDue(followUps);
    await followUps.alarm.poll();
    expect(syncBlog).toHaveBeenCalledTimes(2);
    expect(await followUps.alarm.when(blogID)).toBe(null);
  });
});
