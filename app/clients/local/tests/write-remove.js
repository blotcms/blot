describe("local client write and remove", function () {
  global.test.blog();

  const fs = require("fs-extra");
  const os = require("os");
  const { join } = require("path");
  const folder = require("storage/folder");
  const write = require("clients/local/write");
  const remove = require("clients/local/remove");
  const source = require("clients/local/source");
  const { promisify } = require("util");

  let base;
  let saved;
  let dir;

  beforeEach(async function () {
    saved = process.env.BLOT_LOCAL_SOURCE_DIRECTORY;
    base = await fs.mkdtemp(join(os.tmpdir(), "local-client-"));
    process.env.BLOT_LOCAL_SOURCE_DIRECTORY = base;
    dir = await source.directory(this.blog.id);
  });

  afterEach(async function () {
    if (saved === undefined) delete process.env.BLOT_LOCAL_SOURCE_DIRECTORY;
    else process.env.BLOT_LOCAL_SOURCE_DIRECTORY = saved;
    await fs.remove(base);
  });

  describe("against storage/folder", function () {
    it("writes a file into the source directory and the blog folder, creating parents", async function () {
      await promisify(write)(this.blog.id, "/posts/hello.txt", "Hello");
      const contents = await folder.read(this.blog.id, "/posts/hello.txt");
      expect(contents.toString()).toBe("Hello");
      expect(await fs.readFile(join(dir, "posts", "hello.txt"), "utf8")).toBe(
        "Hello"
      );
    });

    it("returns promises when called without a callback", async function () {
      await write(this.blog.id, "/promise.txt", "P");
      expect((await folder.read(this.blog.id, "/promise.txt")).toString()).toBe(
        "P"
      );
      await remove(this.blog.id, "/promise.txt");
      expect(await folder.exists(this.blog.id, "/promise.txt")).toBe(false);

      let error;
      try {
        await write(this.blog.id, "/.DS_Store", "x");
      } catch (err) {
        error = err;
      }
      expect(error).toBeDefined();
    });

    it("does not write an ignored name", async function () {
      let error;
      try {
        await promisify(write)(this.blog.id, "/.DS_Store", "x");
      } catch (err) {
        error = err;
      }
      expect(error).toBeDefined();
      expect(await folder.exists(this.blog.id, "/.DS_Store")).toBe(false);
      expect(await fs.pathExists(join(dir, ".DS_Store"))).toBe(false);
    });

    it("removes a file and a directory from both", async function () {
      await promisify(write)(this.blog.id, "/a/b.txt", "b");
      await promisify(remove)(this.blog.id, "/a/b.txt");
      expect(await folder.exists(this.blog.id, "/a/b.txt")).toBe(false);
      expect(await fs.pathExists(join(dir, "a", "b.txt"))).toBe(false);
      await promisify(write)(this.blog.id, "/dir/c.txt", "c");
      await promisify(remove)(this.blog.id, "/dir");
      expect(await folder.exists(this.blog.id, "/dir")).toBe(false);
      expect(await fs.pathExists(join(dir, "dir"))).toBe(false);
    });

    it("treats removing a missing path as a no-op", async function () {
      await promisify(remove)(this.blog.id, "/missing.txt");
    });

    it("will not write outside the source directory", async function () {
      await promisify(write)(this.blog.id, "/../../escape.txt", "x");
      expect(await fs.pathExists(join(base, "escape.txt"))).toBe(false);
      expect(await fs.pathExists(join(dir, "escape.txt"))).toBe(true);
    });
  });
});
