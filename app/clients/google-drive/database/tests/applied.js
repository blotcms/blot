const folderModule = require("../folder");
const client = require("models/client");
const prefix = require("../prefix");

describe("Drive applied records", function () {
  let folder;

  beforeEach(function () {
    folder = folderModule("cache-test", "blog-a");
  });
  afterEach(async function () {
    const keys = await client.keys(prefix + "cache-test*");
    if (keys.length) await client.del(keys);
  });

  it("stores Drive's modifiedTime and the SHA-1 Blot wrote, nothing else", async function () {
    await folder.setApplied("file", { modifiedTime: "2026-01-01T00:00:00Z" });
    expect(await folder.getApplied("file")).toEqual({
      modifiedTime: "2026-01-01T00:00:00Z",
    });
    await folder.setApplied("file", {
      modifiedTime: "2026-01-01T00:00:00Z",
      sha1: "sha",
      size: 4,
      modified: 1000,
    });
    expect(await folder.getApplied("file")).toEqual({
      modifiedTime: "2026-01-01T00:00:00Z",
      sha1: "sha",
    });
  });

  it("keeps each blog's records apart on a shared folder", async function () {
    const other = folderModule("cache-test", "blog-b");
    await folder.setApplied("file", { modifiedTime: "t", sha1: "sha" });
    expect(await other.getApplied("file")).toBeNull();
    await other.forgetOwn();
    expect(await folder.getApplied("file")).toEqual({
      modifiedTime: "t",
      sha1: "sha",
    });
  });

  it("clears a record when its file is removed or the mapping reset", async function () {
    const applied = { modifiedTime: "t", sha1: "sha" };
    await folder.set("file", "/file.txt");
    await folder.setApplied("file", applied);
    await folder.remove("file");
    expect(await folder.getApplied("file")).toBeNull();
    await folder.setApplied("file", applied);
    await folder.reset();
    expect(await folder.getApplied("file")).toBeNull();
  });

  it("keeps records across a resync's reset and prunes removed IDs", async function () {
    const applied = { modifiedTime: "2026-01-01T00:00:00Z", sha1: "sha" };
    await folder.set("file", "/file.txt");
    await folder.setApplied("file", applied);
    await folder.setApplied("removed", applied);
    await folder.reset({ keepApplied: true });
    expect(await folder.getApplied("file")).toEqual(applied);
    await folder.set("file", "/file.txt");
    await folder.pruneApplied();
    expect(await folder.getApplied("file")).toEqual(applied);
    expect(await folder.getApplied("removed")).toBeNull();
  });
});
