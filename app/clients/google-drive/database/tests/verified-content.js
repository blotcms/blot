const folderModule = require("../folder");
const client = require("models/client");
const prefix = require("../prefix");
describe("Drive verified-content storage", function() {
  const record = {
    path: "/file.txt",
    checksum: "md5",
    fingerprint: "disk-stat"
  };
  let folder;
  beforeEach(function() {
    folder = folderModule("cache-test", "blog-a");
  });
  afterEach(async function() {
    const keys = await client.keys(prefix + "cache-test*");
    if (keys.length) await client.del(keys);
  });
  it("batch reads verification independently of metadata writes", async function() {
    await folder.set("file", "/file.txt", {
      modifiedTime: "old"
    });
    await folder.setVerifiedContent("file", record);
    await folder.set("file", "/file.txt", {
      modifiedTime: "new"
    });
    const batch = spyOn(client, "hmGet").and.callThrough();
    expect(await folder.getVerifiedContents(["file", "missing"])).toEqual([record, null]);
    expect(batch.calls.count()).toBe(1);
  });
  it("keeps local fingerprints and migration cursors separate for shared remote folders", async function() {
    const other = folderModule("cache-test", "blog-b");
    await folder.setVerifiedContent("file", record);
    await other.setVerifiedContent("file", {
      ...record,
      fingerprint: "other-disk"
    });
    await folder.setMigrationCursor("/z");
    await other.setMigrationCursor("/a");
    expect(await folder.getVerifiedContents(["file"])).toEqual([record]);
    expect((await other.getVerifiedContents(["file"]))[0].fingerprint).toBe("other-disk");
    expect(await folder.getMigrationCursor()).toBe("/z");
    expect(await other.getMigrationCursor()).toBe("/a");
  });
  it("clears verification when files are removed or reset normally", async function() {
    await folder.set("file", "/file.txt");
    await folder.setVerifiedContent("file", record);
    await folder.remove("file");
    expect(await folder.getVerifiedContents(["file"])).toEqual([null]);
    await folder.setVerifiedContent("file", record);
    await folder.setMigrationCursor("/z");
    await folder.reset();
    expect(await folder.getVerifiedContents(["file"])).toEqual([null]);
    expect(await folder.getMigrationCursor()).toBe("");
  });
  it("preserves warm records across mapping resync and prunes removed IDs afterward", async function() {
    await folder.set("file", "/file.txt");
    await folder.setVerifiedContent("file", record);
    await folder.setVerifiedContent("removed", {
      ...record,
      path: "/removed.txt"
    });
    await folder.setMigrationCursor("/z");
    await folder.reset({
      preserveVerifiedContent: true
    });
    expect(await folder.getVerifiedContents(["file"])).toEqual([record]);
    expect(await folder.getMigrationCursor()).toBe("/z");
    await folder.set("file", "/file.txt");
    await folder.pruneVerifiedContents();
    expect(await folder.getVerifiedContents(["file", "removed"])).toEqual([record, null]);
  });
});
