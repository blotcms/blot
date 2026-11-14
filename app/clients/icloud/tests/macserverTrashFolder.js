// Disconnect takes a shared folder off the macserver through Finder, never by
// deleting its files, which would delete them for the folder's owner too.
const fs = require("fs-extra");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");

describe("icloud macserver trashFolder", function () {
  let trashFolder;
  let script;
  let dir;

  beforeAll(async function () {
    ({ default: trashFolder, script } = await import(
      pathToFileURL(path.join(__dirname, "../macserver/util/trashFolder.js"))
        .href
    ));
  });

  beforeEach(async function () {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "trash-folder-"));
    await fs.outputFile(path.join(dir, "blog_x", "post.txt"), "hello");
  });

  afterEach(async function () {
    await fs.remove(dir);
  });

  it("has Finder delete the folder itself, then empty the Trash", async function () {
    const target = path.join(dir, "blog_x");
    const run = jasmine.createSpy("run").and.callFake(async () => {
      // what Finder does: the folder leaves, its files are not unlinked one by one
      await fs.move(target, path.join(dir, "trashed"));
    });

    expect(await trashFolder(target, { run })).toBe(true);

    const [command, args] = run.calls.argsFor(0);
    expect(command).toBe("osascript");
    expect(args).toEqual(["-e", script, target]);
    expect(script).toContain("delete target");
    expect(script).toContain("empty the trash");
    expect(await fs.pathExists(path.join(dir, "trashed", "post.txt"))).toBe(
      true
    );
  });

  it("throws, leaving the folder, when Finder doesn't move it", async function () {
    const target = path.join(dir, "blog_x");
    let error;

    try {
      await trashFolder(target, { run: async () => {} });
    } catch (err) {
      error = err;
    }

    expect(error.message).toContain("did not move");
    expect(await fs.pathExists(path.join(target, "post.txt"))).toBe(true);
  });

  it("does nothing for a folder that isn't there", async function () {
    const run = jasmine.createSpy("run");

    expect(await trashFolder(path.join(dir, "missing"), { run })).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });
});
