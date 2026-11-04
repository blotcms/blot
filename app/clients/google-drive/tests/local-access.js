const fs = require("fs-extra");
const folder = require("storage/folder");
const contentFingerprint = require("../util/contentFingerprint");
const localFingerprint = require("../util/localFingerprint");
const localFile = require("../util/localFile");
const localReaddir = require("../sync/util/localReaddir");

// The Drive client reaches the blog folder through storage/folder. These use
// the real config and a real blog folder, because the fingerprints stored in
// Redis must keep matching what is computed from the disk.
describe("Drive client access to the blog folder", function () {
  global.test.blog();

  it("fingerprints a file as its size and nanosecond mtime, as before", async function () {
    await folder.write(this.blog.id, "/a.txt", "hello");

    const real = await fs.stat(await folder.ensureLocal(this.blog.id, "/a.txt"), { bigint: true });
    const expected = real.size + ":" + real.mtimeNs;

    expect(await localFingerprint(this.blog.id, "/a.txt")).toEqual(expected);
    expect(await localFingerprint(this.blog.id, "/a.txt")).toEqual(contentFingerprint(real));
    expect(contentFingerprint.sameFingerprint(expected, await localFingerprint(this.blog.id, "/a.txt"))).toBe(true);
  });

  it("still matches an old five-field stored fingerprint", async function () {
    await folder.write(this.blog.id, "/a.txt", "hello");

    const real = await fs.stat(await folder.ensureLocal(this.blog.id, "/a.txt"), { bigint: true });
    const old = [real.dev, real.ino, real.size, real.mtimeNs, real.ctimeNs].join(":");

    expect(contentFingerprint.sameFingerprint(old, await localFingerprint(this.blog.id, "/a.txt"))).toBe(true);
  });

  it("has no fingerprint for a missing file or a directory", async function () {
    await folder.mkdir(this.blog.id, "/dir");

    expect(await localFingerprint(this.blog.id, "/missing.txt")).toBeNull();
    expect(await localFingerprint(this.blog.id, "/dir")).toBeNull();
  });

  describe("localReaddir", function () {
    it("lists names, sizes and times from storage/folder, as the disk has them", async function () {
      await folder.write(this.blog.id, "/b.txt", "bb");
      await folder.write(this.blog.id, "/a/inner.txt", "i");

      const items = await localReaddir(this.blog.id, "/");
      const byName = {};
      items.forEach((item) => (byName[item.name] = item));

      expect(Object.keys(byName).sort()).toEqual(["a", "b.txt"]);

      const real = await folder.stat(this.blog.id, "/b.txt");

      expect(byName["b.txt"]).toEqual({
        name: "b.txt",
        isDirectory: false,
        size: 2,
        modified: real.modified,
        modifiedTime: new Date(Math.round(real.modified)).toISOString(),
      });
      expect(byName.a.isDirectory).toBe(true);
      expect(byName.a.modifiedTime).toBeUndefined();
    });

    it("never asks for a local copy of the directory", async function () {
      await folder.write(this.blog.id, "/b.txt", "bb");
      spyOn(folder, "ensureLocal").and.callThrough();

      await localReaddir(this.blog.id, "/");

      expect(folder.ensureLocal).not.toHaveBeenCalled();
    });

    it("lists both of two names which differ only by case", async function () {
      await folder.write(this.blog.id, "/Photo.txt", "1");
      await folder.write(this.blog.id, "/photo.txt", "2");

      const names = (await localReaddir(this.blog.id, "/")).map((item) => item.name).sort();

      expect(names).toEqual(["Photo.txt", "photo.txt"]);
    });

    it("rejects for a missing directory rather than listing nothing", async function () {
      let error;

      try {
        await localReaddir(this.blog.id, "/missing");
      } catch (err) {
        error = err;
      }

      expect(error && error.code).toEqual("ENOENT");
    });
  });

  describe("localFile", function () {
    it("is the file's local path", async function () {
      await folder.write(this.blog.id, "/a.txt", "hello");

      const local = await localFile(this.blog.id, "/a.txt");

      expect(local).toEqual(await folder.ensureLocal(this.blog.id, "/a.txt"));
      expect((await fs.readFile(local)).toString()).toEqual("hello");
    });

    it("is null only when the file is missing", async function () {
      await folder.write(this.blog.id, "/a.txt", "hello");

      expect(await localFile(this.blog.id, "/missing.txt")).toBeNull();
      expect(await localFile(this.blog.id, "/a.txt/below")).toBeNull();
    });
  });
});
