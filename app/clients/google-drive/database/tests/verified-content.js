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
  it("keeps local fingerprints separate for shared remote folders", async function() {
    const other = folderModule("cache-test", "blog-b");
    await folder.setVerifiedContent("file", record);
    await other.setVerifiedContent("file", {
      ...record,
      fingerprint: "other-disk"
    });
    expect(await folder.getVerifiedContents(["file"])).toEqual([record]);
    expect((await other.getVerifiedContents(["file"]))[0].fingerprint).toBe("other-disk");
  });
  it("clears verification when files are removed or reset normally", async function() {
    await folder.set("file", "/file.txt");
    await folder.setVerifiedContent("file", record);
    await folder.remove("file");
    expect(await folder.getVerifiedContents(["file"])).toEqual([null]);
    await folder.setVerifiedContent("file", record);
    await folder.reset();
    expect(await folder.getVerifiedContents(["file"])).toEqual([null]);
  });
  it("preserves warm records across mapping resync and prunes removed IDs afterward", async function() {
    await folder.set("file", "/file.txt");
    await folder.setVerifiedContent("file", record);
    await folder.setVerifiedContent("removed", {
      ...record,
      path: "/removed.txt"
    });
    await folder.reset({
      preserveVerifiedContent: true
    });
    expect(await folder.getVerifiedContents(["file"])).toEqual([record]);
    await folder.set("file", "/file.txt");
    await folder.pruneVerifiedContents();
    expect(await folder.getVerifiedContents(["file", "removed"])).toEqual([record, null]);
  });
  it("reads records which pair the checksum with the file's state, and older fingerprint ones", async function() {
    const paired = {
      path: "/file.txt",
      checksum: "md5",
      sha1: "sha",
      size: 4,
      modified: 1000
    };
    await folder.setVerifiedContent("paired", paired);
    await folder.setVerifiedContent("legacy", record);
    await folder.setVerifiedContent("neither", { path: "/file.txt", checksum: "md5" });
    await folder.setVerifiedContent("unhashed", { ...paired, sha1: null });
    expect(await folder.getVerifiedContents(["paired", "legacy", "neither", "unhashed"]))
      .toEqual([paired, record, null, { ...paired, sha1: null }]);
  });
  it("stores an applied record without a state it was not given", async function() {
    await folder.setApplied("file", { modifiedTime: "2026-01-01T00:00:00Z" });
    expect(await folder.getApplied("file")).toEqual({ modifiedTime: "2026-01-01T00:00:00Z" });
    await folder.setApplied("file", { modifiedTime: "2026-01-01T00:00:00Z", size: 4, modified: 1000 });
    expect(await folder.getApplied("file")).toEqual({ modifiedTime: "2026-01-01T00:00:00Z", size: 4, modified: 1000, sha1: null });
  });
  it("keeps applied records across mapping resync and prunes removed IDs", async function() {
    await folder.set("file", "/file.txt");
    await folder.setApplied("file", { modifiedTime: "2026-01-01T00:00:00Z", size: 4, modified: 1000, sha1: "sha" });
    await folder.setApplied("removed", { modifiedTime: "2026-01-01T00:00:00Z", size: 4, modified: 1000, sha1: "sha" });
    await folder.reset({ preserveVerifiedContent: true });
    expect(await folder.getApplied("file")).toEqual({ modifiedTime: "2026-01-01T00:00:00Z", size: 4, modified: 1000, sha1: "sha" });
    await folder.set("file", "/file.txt");
    await folder.pruneVerifiedContents();
    expect(await folder.getApplied("file")).toEqual({ modifiedTime: "2026-01-01T00:00:00Z", size: 4, modified: 1000, sha1: "sha" });
    expect(await folder.getApplied("removed")).toBeNull();
    await folder.reset();
    expect(await folder.getApplied("file")).toBeNull();
  });
});
