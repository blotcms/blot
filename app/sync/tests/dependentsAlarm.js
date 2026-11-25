// A killed sync's rebuilds are picked up by an alarm, so a blog which never
// syncs again still gets them (sync/dependentsAlarm.js)
describe("sync dependents alarm", function () {
  const sync = require("../index");
  const Entry = require("models/entry");
  const client = require("models/client");
  const sharp = require("sharp");
  const dependents = require("../update/dependents");
  const dependentsAlarm = require("../dependentsAlarm");

  const DUE = "alarm:due:dependents";
  const imagePath = "/assets/image.png";
  const postPath = "/post.txt";

  const png = (background) =>
    sharp({ create: { width: 40, height: 40, channels: 4, background } })
      .png()
      .toBuffer();

  global.test.blog();

  beforeEach(async function () {
    await this.blog.write({ path: imagePath, content: await png("#000") });
    await this.blog.write({ path: postPath, content: `![Alt](${imagePath})` });
    await this.blog.rebuild();
    await this.blog.check({ path: postPath });
    await dependentsAlarm.alarm.cancel(this.blog.id);

    this.postBuilds = () =>
      Entry.set.calls.allArgs().filter((args) => args[1] === postPath).length;
  });

  afterEach(async function () {
    await client.del([
      dependents.pendingKey(this.blog.id),
      dependents.targetsKey(this.blog.id),
    ]);
    await dependentsAlarm.alarm.cancel(this.blog.id);
  });

  it("is set by a sync which records rebuilds", async function () {
    await this.blog.write({ path: imagePath, content: await png("#f00") });
    const before = Date.now();

    await sync(this.blog.id, (folder) => folder.update(imagePath));

    const due = await client.zScore(DUE, this.blog.id);
    expect(due).toBeGreaterThanOrEqual(before + dependentsAlarm.DELAY_MS);
  });

  it("finds nothing to do after a sync which finished its rebuilds", async function () {
    await this.blog.write({ path: imagePath, content: await png("#00f") });
    await sync(this.blog.id, (folder) => folder.update(imagePath));
    spyOn(Entry, "set").and.callThrough();

    await dependentsAlarm.run(this.blog.id);

    expect(this.postBuilds()).toBe(0);
  });

  it("rebuilds what a killed sync left pending", async function () {
    await this.blog.write({ path: imagePath, content: await png("#0f0") });
    // What a sync killed after saving the image's entry leaves
    await client.sAdd(dependents.pendingKey(this.blog.id), imagePath);
    spyOn(Entry, "set").and.callThrough();

    await dependentsAlarm.run(this.blog.id);

    expect(this.postBuilds()).toBe(1);
    expect(await client.sMembers(dependents.pendingKey(this.blog.id))).toEqual(
      []
    );
  });

  it("does nothing when nothing is pending", async function () {
    spyOn(Entry, "set").and.callThrough();

    await dependentsAlarm.run(this.blog.id);

    expect(this.postBuilds()).toBe(0);
    expect(await client.zScore(DUE, this.blog.id)).toBe(null);
  });

  it("stays set while a sync holds the lock, even with nothing pending yet", async function () {
    const { done } = await sync.establishSyncLock(this.blog.id);

    try {
      await dependentsAlarm.run(this.blog.id);
      expect(await client.zScore(DUE, this.blog.id)).toBeGreaterThan(
        Date.now()
      );
    } finally {
      await done();
    }
  });

  it("looks again later while the folder is locked", async function () {
    await client.sAdd(dependents.pendingKey(this.blog.id), imagePath);
    const { done } = await sync.establishSyncLock(this.blog.id);

    try {
      await dependentsAlarm.run(this.blog.id);
      expect(await client.zScore(DUE, this.blog.id)).toBeGreaterThan(
        Date.now()
      );
    } finally {
      await done();
    }
  });
});
