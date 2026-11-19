// A sync only checks for renames when an update changed something, and only
// builds templates from the folder when a templates path was updated.
describe("sync end-of-sync work", function () {
  const storage = require("storage/folder");
  const template = require("models/template");
  const folderRenames = require("models/template/folderRenames");
  const templateKey = require("models/template/key");
  const client = require("models/client");

  const syncPath = require.resolve("../index");
  const renamesPath = require.resolve("../renames");

  let originalSync, originalRenames, renamesSpy, sync;

  global.test.blog();

  beforeEach(function () {
    originalSync = require.cache[syncPath];
    originalRenames = require.cache[renamesPath];
    renamesSpy = jasmine
      .createSpy("renames")
      .and.returnValue(Promise.resolve());
    require.cache[renamesPath] = { exports: renamesSpy };
    spyOn(template, "buildFromFolder").and.returnValue(Promise.resolve());
    delete require.cache[syncPath];
    sync = require("../index");
  });

  afterEach(async function () {
    await client.del(templateKey.needsBuild(this.blog.id));
    if (originalSync) require.cache[syncPath] = originalSync;
    else delete require.cache[syncPath];
    if (originalRenames) require.cache[renamesPath] = originalRenames;
    else delete require.cache[renamesPath];
  });

  it("does neither when nothing was updated", async function () {
    await sync(this.blog.id, async function () {});

    expect(renamesSpy).not.toHaveBeenCalled();
    expect(template.buildFromFolder).not.toHaveBeenCalled();
  });

  it("checks renames but doesn't build templates when a post changed", async function () {
    const blogID = this.blog.id;
    await storage.write(blogID, "/hello.txt", "Hello");

    await sync(blogID, async function (folder) {
      await folder.update("/hello.txt");
    });

    expect(renamesSpy).toHaveBeenCalledWith(blogID);
    expect(template.buildFromFolder).not.toHaveBeenCalled();
  });

  it("skips renames when every update came back unchanged", async function () {
    const blogID = this.blog.id;
    await storage.write(blogID, "/hello.txt", "Hello");
    await sync(blogID, async function (folder) {
      await folder.update("/hello.txt");
    });
    renamesSpy.calls.reset();

    await sync(blogID, async function (folder) {
      const result = await folder.update("/hello.txt");
      expect(result.changed).toBe(false);
    });

    expect(renamesSpy).not.toHaveBeenCalled();
    expect(template.buildFromFolder).not.toHaveBeenCalled();
  });

  it("builds templates when a path in the templates folder was updated", async function () {
    const blogID = this.blog.id;

    await sync(blogID, async function (folder) {
      await folder.update("/Templates/mine/package.json");
    });

    expect(template.buildFromFolder).toHaveBeenCalledWith(blogID);
  });

  it("builds templates when the templates folder itself was updated", async function () {
    const blogID = this.blog.id;

    await sync(blogID, async function (folder) {
      await folder.update("/Templates");
    });

    expect(template.buildFromFolder).toHaveBeenCalledWith(blogID);
  });

  it("retries a build which failed to read a template, then clears the key", async function () {
    const blogID = this.blog.id;
    const key = templateKey.needsBuild(blogID);
    template.buildFromFolder.and.returnValue(Promise.resolve({ failed: 1 }));

    await sync(blogID, async function (folder) {
      await folder.update("/Templates/mine/package.json");
    });

    expect(template.buildFromFolder).toHaveBeenCalledTimes(1);
    expect(await client.exists(key)).toBe(1);

    // The next sync updates no template path, but still builds
    template.buildFromFolder.and.returnValue(Promise.resolve({ failed: 0 }));
    await sync(blogID, async function () {});

    expect(template.buildFromFolder).toHaveBeenCalledTimes(2);
    expect(await client.exists(key)).toBe(0);

    // and the one after that does not
    await sync(blogID, async function () {});
    expect(template.buildFromFolder).toHaveBeenCalledTimes(2);
  });

  it("builds templates when the folder root was updated", async function () {
    const blogID = this.blog.id;

    await sync(blogID, async function (folder) {
      await folder.update("/");
    });

    expect(template.buildFromFolder).toHaveBeenCalledWith(blogID);
  });

  it("builds templates when an installed template's removal is pending", async function () {
    const blogID = this.blog.id;
    await folderRenames.setPending(blogID, "SITE_x", { since: Date.now() });

    try {
      await sync(blogID, async function () {});
    } finally {
      await folderRenames.clear(blogID, "SITE_x");
    }

    expect(template.buildFromFolder).toHaveBeenCalledWith(blogID);
  });
});
