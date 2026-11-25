// What depends on the files a sync changes is rebuilt once, when the sync
// ends (update/dependents.js), not once per file
describe("sync dependents batch", function () {
  const sync = require("../index");
  const Entry = require("models/entry");
  const client = require("models/client");
  const sharp = require("sharp");
  const dependents = require("../update/dependents");

  // A distinct image for each colour
  const png = (background) =>
    sharp({ create: { width: 40, height: 40, channels: 4, background } })
      .png()
      .toBuffer();

  global.test.blog();

  const images = ["/assets/a.png", "/assets/b.png", "/assets/c.png"];
  const postPath = "/post.txt";
  const postText = images.map((path) => `![Alt](${path})`).join("\n\n");

  beforeEach(async function () {
    for (const path of images)
      await this.blog.write({ path, content: await png("#000") });
    await this.blog.write({ path: postPath, content: postText });
    await this.blog.rebuild();
    await this.blog.check({ path: postPath });

    // The rebuild drains what it recorded: start each spec from nothing
    expect(await client.sMembers(dependents.pendingKey(this.blog.id))).toEqual(
      []
    );

    this.recolour = async (colour) => {
      for (const path of images)
        await this.blog.write({ path, content: await png(colour) });
    };
    this.postBuilds = () =>
      Entry.set.calls.allArgs().filter((args) => args[1] === postPath).length;
  });

  afterEach(async function () {
    await client.del([
      dependents.pendingKey(this.blog.id),
      dependents.targetsKey(this.blog.id),
    ]);
  });

  it("rebuilds a post once for a batch of its images", async function () {
    await this.recolour("#f00");
    spyOn(Entry, "set").and.callThrough();

    await sync(this.blog.id, async (folder) => {
      for (const path of images) await folder.update(path);
    });

    expect(this.postBuilds()).toBe(1);
    expect(await client.sMembers(dependents.pendingKey(this.blog.id))).toEqual(
      []
    );
    expect(await client.sMembers(dependents.targetsKey(this.blog.id))).toEqual(
      []
    );
  });

  it("doesn't rebuild a post saved after its images in the same sync", async function () {
    await this.recolour("#0f0");
    await this.blog.write({ path: postPath, content: postText + "\n\nMore." });
    spyOn(Entry, "set").and.callThrough();

    await sync(this.blog.id, async (folder) => {
      for (const path of images) await folder.update(path);
      await folder.update(postPath);
    });

    expect(this.postBuilds()).toBe(1);
  });

  it("rebuilds a post saved before its images in the same sync", async function () {
    await this.recolour("#00f");
    await this.blog.write({ path: postPath, content: postText + "\n\nMore." });
    spyOn(Entry, "set").and.callThrough();

    await sync(this.blog.id, async (folder) => {
      await folder.update(postPath);
      for (const path of images) await folder.update(path);
    });

    expect(this.postBuilds()).toBe(2);
  });

  it("rebuilds what another sync left pending, in the next sync", async function () {
    // What a sync killed before its end leaves
    await client.sAdd(dependents.pendingKey(this.blog.id), images[0]);
    await this.blog.write({ path: "/other.txt", content: "Other" });
    spyOn(Entry, "set").and.callThrough();

    await sync(this.blog.id, (folder) => folder.update("/other.txt"));

    expect(this.postBuilds()).toBe(1);
    expect(await client.sMembers(dependents.pendingKey(this.blog.id))).toEqual(
      []
    );
  });

  it("rebuilds a post whose image was removed", async function () {
    await this.blog.remove(images[0]);
    spyOn(Entry, "set").and.callThrough();

    await sync(this.blog.id, (folder) => folder.update(images[0]));

    expect(this.postBuilds()).toBe(1);
  });

  it("answers unchanged for a file synced twice in one sync", async function () {
    await this.recolour("#ff0");
    spyOn(Entry, "set").and.callThrough();
    let second;

    await sync(this.blog.id, async (folder) => {
      await folder.update(images[0]);
      second = await folder.update(images[0]);
    });

    expect(second.changed).toBe(false);
    expect(this.postBuilds()).toBe(1);
    expect(await client.sMembers(dependents.pendingKey(this.blog.id))).toEqual(
      []
    );
  });

  it("rebuilds the dependents before the answer, with drainDependents", async function () {
    await this.recolour("#0ff");
    const { folder, done } = await sync.establishSyncLock(this.blog.id);
    spyOn(Entry, "set").and.callThrough();

    await folder.run(async () => {
      await folder.update(images[0]);
      await folder.drainDependents();
      expect(this.postBuilds()).toBe(1);
    });

    await done();
    expect(this.postBuilds()).toBe(1);
  });
});
