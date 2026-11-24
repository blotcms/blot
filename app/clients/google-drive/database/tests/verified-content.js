const folderModule = require("../folder");
const client = require("models/client");
const prefix = require("../prefix");

// Verified records are only read now, for a walk to take over
// (sync/sync.js); util/hashes.js holds the pairs. These write the old records
// straight to Redis, as earlier syncs left them.
describe("Drive verified-content storage", function () {
  const record = {
    path: "/file.txt",
    checksum: "md5",
    sha1: "sha",
    size: 4,
    modified: 1000,
  };
  let folder;
  const plant = (target, id, value) =>
    client.hSet(target.contentKey, id, JSON.stringify(value));

  beforeEach(function () {
    folder = folderModule("cache-test", "blog-a");
  });
  afterEach(async function () {
    const keys = await client.keys(prefix + "cache-test*");
    if (keys.length) await client.del(keys);
  });

  it("batch reads old records in one request", async function () {
    await plant(folder, "file", record);
    const batch = spyOn(client, "hmGet").and.callThrough();
    expect(await folder.getVerifiedContents(["file", "missing"])).toEqual([
      record,
      null,
    ]);
    expect(batch.calls.count()).toBe(1);
  });

  it("reads only records with a checksum and a SHA-1, which a walk can take over", async function () {
    await plant(folder, "paired", record);
    await plant(folder, "fingerprint", {
      path: "/file.txt",
      checksum: "md5",
      fingerprint: "disk-stat",
    });
    await plant(folder, "unhashed", { ...record, sha1: null });
    expect(
      await folder.getVerifiedContents(["paired", "fingerprint", "unhashed"])
    ).toEqual([record, null, null]);
  });

  it("keeps each blog's old records apart on a shared folder", async function () {
    const other = folderModule("cache-test", "blog-b");
    await plant(folder, "file", record);
    expect(await other.getVerifiedContents(["file"])).toEqual([null]);
  });

  it("clears old records when files are removed or reset normally", async function () {
    await folder.set("file", "/file.txt");
    await plant(folder, "file", record);
    await folder.remove("file");
    expect(await folder.getVerifiedContents(["file"])).toEqual([null]);
    await plant(folder, "file", record);
    await folder.reset();
    expect(await folder.getVerifiedContents(["file"])).toEqual([null]);
  });

  it("stores an applied record as Drive's modifiedTime and the SHA-1 Blot wrote", async function () {
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

  it("keeps applied records across mapping resync and prunes removed IDs", async function () {
    const applied = { modifiedTime: "2026-01-01T00:00:00Z", sha1: "sha" };
    await folder.set("file", "/file.txt");
    await folder.setApplied("file", applied);
    await folder.setApplied("removed", applied);
    await folder.reset({ preserveVerifiedContent: true });
    expect(await folder.getApplied("file")).toEqual(applied);
    await folder.set("file", "/file.txt");
    await folder.pruneVerifiedContents();
    expect(await folder.getApplied("file")).toEqual(applied);
    expect(await folder.getApplied("removed")).toBeNull();
    await folder.reset();
    expect(await folder.getApplied("file")).toBeNull();
  });
});
