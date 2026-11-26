// A file's entry is saved before what depends on it is rebuilt (at the end of
// the sync, update/dependents.js), so a deploy can kill the sync in between. The path is recorded as pending first, and a
// later sync of the same file rebuilds its dependents even though its own
// entry comes out unchanged.
describe("sync dependents pending", function () {
  const sync = require("../index");
  const Entry = require("models/entry");
  const client = require("models/client");
  const sharp = require("sharp");
  const { dependentsPendingKey } = require("../update/set");

  // A different image from the one the post was built with
  const greenPng = () =>
    sharp({
      create: { width: 400, height: 400, channels: 4, background: "#0f0" },
    })
      .png()
      .toBuffer();

  global.test.blog();

  const imagePath = "/assets/image.png";
  const postPath = "/post.txt";

  beforeEach(async function () {
    await this.blog.write({
      path: imagePath,
      content: await global.test.fake.pngBuffer(),
    });
    await this.blog.write({ path: postPath, content: `![Alt](${imagePath})` });
    await this.blog.rebuild();
    await this.blog.check({ path: postPath });

    this.pendingKey = dependentsPendingKey(this.blog.id);
    this.update = (path) => sync(this.blog.id, (folder) => folder.update(path));
  });

  afterEach(async function () {
    await client.del([
      this.pendingKey,
      require("../update/dependents").targetsKey(this.blog.id),
    ]);
  });

  const rebuiltPost = () =>
    Entry.set.calls.allArgs().some((args) => args[1] === postPath);

  it("leaves nothing pending once a file's dependents are rebuilt", async function () {
    await this.blog.write({ path: imagePath, content: await greenPng() });

    await this.update(imagePath);

    expect(await client.sMembers(this.pendingKey)).toEqual([]);
  });

  it("skips the dependents of an unchanged file", async function () {
    spyOn(Entry, "set").and.callThrough();

    const result = await this.update(imagePath);

    expect(result.changed).toBe(false);
    expect(rebuiltPost()).toBe(false);
    expect(await client.sMembers(this.pendingKey)).toEqual([]);
  });

  it("rebuilds the dependents of an unchanged file left pending", async function () {
    // What a sync killed between Entry.set and rebuildDependents leaves
    await client.sAdd(this.pendingKey, imagePath);
    spyOn(Entry, "set").and.callThrough();

    const result = await this.update(imagePath);

    expect(result.changed).not.toBe(false);
    expect(rebuiltPost()).toBe(true);
    expect(await client.sMembers(this.pendingKey)).toEqual([]);
  });

  it("keeps the path pending when rebuilding its dependents fails", async function () {
    const sMembers = client.sMembers.bind(client);

    spyOn(client, "sMembers").and.callFake(function (key) {
      if (key.indexOf(":dependents:") > -1)
        return Promise.reject(new Error("killed"));
      return sMembers(key);
    });

    await this.blog.write({ path: imagePath, content: await greenPng() });

    await this.update(imagePath).catch(() => {});

    client.sMembers.and.callThrough();
    expect(await client.sMembers(this.pendingKey)).toEqual([imagePath]);
  });
});
