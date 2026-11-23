describe("demo folder ZIPs", function () {
  const fs = require("fs-extra");
  const { join } = require("path");
  const s3 = require("storage/s3");
  const tempDir = require("helper/tempDir");
  const { hashFolder, listFiles } = require("templates/folders/contents");
  const publishZip = require("templates/folders/publishZip");

  let directory;

  beforeEach(async function () {
    directory = join(
      tempDir(),
      "folder-zips-spec-" + Date.now() + "-" + Math.random()
    );
    await fs.outputFile(join(directory, "Hello.txt"), "Hello");
    await fs.outputFile(join(directory, "Pages/About.md"), "# About");
  });

  afterEach(async function () {
    await fs.remove(directory);
  });

  it("lists every file, sorted, with forward slashes", async function () {
    expect(await listFiles(directory)).toEqual(["Hello.txt", "Pages/About.md"]);
  });

  it("hashes the same files the same anywhere, and a change differently", async function () {
    const copy = directory + "-copy";
    await fs.copy(directory, copy);

    try {
      const hash = await hashFolder(directory);
      expect(hash).toMatch(/^[a-f0-9]{16}$/);
      expect(await hashFolder(copy)).toBe(hash);

      await fs.outputFile(join(copy, "Hello.txt"), "Hello!");
      expect(await hashFolder(copy)).not.toBe(hash);

      await fs.outputFile(join(directory, "Hello.txt"), "Hello!");
      await fs.move(join(directory, "Hello.txt"), join(directory, "Hi.txt"));
      expect(await hashFolder(directory)).not.toBe(await hashFolder(copy));
    } finally {
      await fs.remove(copy);
    }
  });

  it("matches only the keys it writes", function () {
    expect(publishZip.KEY.test("bees-0123456789abcdef.zip")).toBe(true);
    expect(publishZip.KEY.test("bees-0123456789abcde.zip")).toBe(false);
    expect(publishZip.KEY.test("../bees-0123456789abcdef.zip")).toBe(false);
    expect(publishZip.KEY.test("bees-0123456789abcdef.zip.html")).toBe(false);
  });

  describe("publishZip", function () {
    let listed;

    beforeEach(function () {
      listed = [];
      spyOn(s3, "uploadFile").and.resolveTo({});
      spyOn(s3, "deleteKeys").and.resolveTo();
      spyOn(s3, "listEntries").and.callFake(async function* () {
        for (const entry of listed) yield entry;
      });
    });

    it("uploads a ZIP the bucket doesn't have, under the folder's hash", async function () {
      spyOn(s3, "head").and.resolveTo(null);

      const result = await publishZip("bees", directory);
      const key = publishZip.keyFor("bees", await hashFolder(directory));

      expect(result.key).toBe(key);
      expect(result.uploaded).toBe(true);
      expect(s3.uploadFile).toHaveBeenCalledWith(key, jasmine.any(String), {
        contentType: "application/zip",
      });
      // The staged ZIP is removed
      const staged = s3.uploadFile.calls.argsFor(0)[1];
      expect(await fs.pathExists(staged)).toBe(false);
    });

    it("doesn't upload a ZIP the bucket has", async function () {
      spyOn(s3, "head").and.resolveTo({ size: 1 });

      const result = await publishZip("bees", directory);

      expect(result.uploaded).toBe(false);
      expect(s3.uploadFile).not.toHaveBeenCalled();
    });

    it("keeps the newest previous ZIP and deletes older ones, of this folder only", async function () {
      spyOn(s3, "head").and.resolveTo({ size: 1 });
      const key = publishZip.keyFor("bees", await hashFolder(directory));

      listed = [
        { key, modified: new Date("2026-11-20") },
        {
          key: "folders/bees-1111111111111111.zip",
          modified: new Date("2026-10-01"),
        },
        {
          key: "folders/bees-2222222222222222.zip",
          modified: new Date("2026-11-01"),
        },
        {
          key: "folders/bees-3333333333333333.zip",
          modified: new Date("2026-09-01"),
        },
        // listEntries("folders/bees-") also finds a folder named bees-and-more
        {
          key: "folders/bees-and-more-4444444444444444.zip",
          modified: new Date("2026-01-01"),
        },
      ];

      const result = await publishZip("bees", directory);

      expect(result.removed).toEqual([
        "folders/bees-1111111111111111.zip",
        "folders/bees-3333333333333333.zip",
      ]);
      expect(s3.deleteKeys).toHaveBeenCalledWith(result.removed);
    });
  });
});
