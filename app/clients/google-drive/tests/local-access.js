const fs = require("fs-extra");
const os = require("os");
const { join } = require("path");
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

  let outside;

  beforeEach(async function () {
    outside = await fs.mkdtemp(join(os.tmpdir(), "drive-local-access-"));
  });

  afterEach(async function () {
    await fs.remove(outside);
  });

  it("fingerprints a file as its size and nanosecond mtime, as before", async function () {
    await folder.write(this.blog.id, "/a.txt", "hello");

    const real = await fs.stat(join(this.blogDirectory, "a.txt"), { bigint: true });
    const expected = real.size + ":" + real.mtimeNs;

    expect(await localFingerprint(this.blog.id, "/a.txt")).toEqual(expected);
    expect(await localFingerprint(this.blog.id, "/a.txt")).toEqual(contentFingerprint(real));
    expect(contentFingerprint.sameFingerprint(expected, await localFingerprint(this.blog.id, "/a.txt"))).toBe(true);
  });

  it("still matches an old five-field stored fingerprint", async function () {
    await folder.write(this.blog.id, "/a.txt", "hello");

    const real = await fs.stat(join(this.blogDirectory, "a.txt"), { bigint: true });
    const old = [real.dev, real.ino, real.size, real.mtimeNs, real.ctimeNs].join(":");

    expect(contentFingerprint.sameFingerprint(old, await localFingerprint(this.blog.id, "/a.txt"))).toBe(true);
  });

  it("has no fingerprint for a missing file or a directory", async function () {
    await folder.mkdir(this.blog.id, "/dir");

    expect(await localFingerprint(this.blog.id, "/missing.txt")).toBeNull();
    expect(await localFingerprint(this.blog.id, "/dir")).toBeNull();
  });

  it("keeps a file's mtime, and so its fingerprint, when it is moved into place", async function () {
    const source = join(outside, "download");
    const when = new Date("2024-03-04T05:06:07.123Z");

    await fs.writeFile(source, "hello");
    await fs.utimes(source, when, when);

    const before = contentFingerprint(await fs.stat(source, { bigint: true }));

    await folder.writeFrom(this.blog.id, "/posts/a.txt", source, { move: true });

    expect(await localFingerprint(this.blog.id, "/posts/a.txt")).toEqual(before);
    expect(await fs.pathExists(source)).toBe(false);
  });

  describe("localReaddir", function () {
    it("lists names, sizes, times and fingerprints as it did from the disk", async function () {
      await folder.write(this.blog.id, "/b.txt", "bb");
      await folder.write(this.blog.id, "/a/inner.txt", "i");

      const items = await localReaddir(this.blog.id, "/");
      const byName = {};
      items.forEach((item) => (byName[item.name] = item));

      expect(Object.keys(byName).sort()).toEqual(["a", "b.txt"]);

      const real = await fs.stat(join(this.blogDirectory, "b.txt"), { bigint: true });

      expect(byName["b.txt"]).toEqual({
        name: "b.txt",
        isDirectory: false,
        size: 2,
        fingerprint: contentFingerprint(real),
        modifiedTime: real.mtime.toISOString(),
      });
      expect(byName.a.isDirectory).toBe(true);
      expect(byName.a.fingerprint).toBeNull();
      expect(byName.a.modifiedTime).toBeUndefined();
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

      expect(await localFile(this.blog.id, "/a.txt")).toEqual(join(this.blogDirectory, "a.txt"));
    });

    it("is null only when the file is missing", async function () {
      await folder.write(this.blog.id, "/a.txt", "hello");

      expect(await localFile(this.blog.id, "/missing.txt")).toBeNull();
      expect(await localFile(this.blog.id, "/a.txt/below")).toBeNull();
    });

    it("throws for anything else, such as a symlink", async function () {
      await fs.writeFile(join(outside, "secret.txt"), "secret");
      await fs.symlink(join(outside, "secret.txt"), join(this.blogDirectory, "link.txt"));

      let error;

      try {
        await localFile(this.blog.id, "/link.txt");
      } catch (err) {
        error = err;
      }

      expect(error && error.code).toEqual("ELOOP");
    });
  });
});
