const fs = require("fs-extra");
const folder = require("storage/folder");
const localFile = require("../util/localFile");
const localReaddir = require("../sync/util/localReaddir");

// The Drive client reaches the blog folder through storage/folder. These use
// the real config and a real blog folder in the storage bucket.
describe("Drive client access to the blog folder", function () {
  global.test.blog();

  describe("localReaddir", function () {
    it("lists names, sizes, times and SHA-1s from storage/folder", async function () {
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
        // From the index, so a walk can match the file without reading it
        sha1: require("crypto").createHash("sha1").update("bb").digest("hex"),
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

      const names = (await localReaddir(this.blog.id, "/"))
        .map((item) => item.name)
        .sort();

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
