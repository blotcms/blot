// The Local client's source directory (#2258 Phase E): changes in it reach the
// blog's folder through storage/folder, setup reconciles the two, and all of it
// works on either backend.
describe("local client source directory", function () {
  global.test.blog();

  const fs = require("fs-extra");
  const os = require("os");
  const { join } = require("path");
  const { promisify } = require("util");
  const folder = require("storage/folder");
  const Blog = require("models/blog");
  const source = require("clients/local/source");
  const watch = require("clients/local/watch");
  const { reconcileSource } = require("clients/local/setup");
  const { reconcile } = require("clients/local/sync");

  let base;
  let saved;
  let dir;

  // Watching waits on the file system and a sync lock; a loaded CI runner
  // can need longer than jasmine's 5 seconds
  let timeout;
  beforeAll(function () {
    timeout = jasmine.DEFAULT_TIMEOUT_INTERVAL;
    jasmine.DEFAULT_TIMEOUT_INTERVAL = 30000;
  });
  afterAll(function () {
    jasmine.DEFAULT_TIMEOUT_INTERVAL = timeout;
  });

  beforeEach(async function () {
    saved = process.env.BLOT_LOCAL_SOURCE_DIRECTORY;
    base = await fs.mkdtemp(join(os.tmpdir(), "local-client-"));
    process.env.BLOT_LOCAL_SOURCE_DIRECTORY = base;
    await promisify(Blog.set)(this.blog.id, { client: "local" });
    dir = await source.directory(this.blog.id);
    spyOn(console, "log");
  });

  afterEach(async function () {
    if (saved === undefined) delete process.env.BLOT_LOCAL_SOURCE_DIRECTORY;
    else process.env.BLOT_LOCAL_SOURCE_DIRECTORY = saved;
    await fs.remove(base);
  });

  async function until(check) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (await check()) return true;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return false;
  }

  async function text(blogID, path) {
    try {
      return (await folder.read(blogID, path)).toString();
    } catch (err) {
      return null;
    }
  }

  describe("against storage/folder", function () {
    describe("watching", function () {
      let watcher;

      beforeEach(async function () {
        await fs.ensureDir(dir);
        watcher = await watch(this.blog.id, dir);
      });

      afterEach(function () {
        watcher.close();
      });

      it("copies a file added in the source to the folder", async function () {
        const id = this.blog.id;
        await fs.outputFile(join(dir, "posts", "new.txt"), "new");
        expect(await until(async () => (await text(id, "/posts/new.txt")) === "new")).toBe(true);
      });

      it("copies a change to a file in the source", async function () {
        const id = this.blog.id;
        await fs.outputFile(join(dir, "a.txt"), "one");
        expect(await until(async () => (await text(id, "/a.txt")) === "one")).toBe(true);
        await fs.outputFile(join(dir, "a.txt"), "two!");
        expect(await until(async () => (await text(id, "/a.txt")) === "two!")).toBe(true);
      });

      it("removes from the folder what is removed from the source", async function () {
        const id = this.blog.id;
        await fs.outputFile(join(dir, "gone.txt"), "x");
        expect(await until(async () => (await text(id, "/gone.txt")) === "x")).toBe(true);
        await fs.remove(join(dir, "gone.txt"));
        expect(await until(async () => !(await folder.exists(id, "/gone.txt")))).toBe(true);
      });
    });

    describe("setup", function () {
      it("reconciles the source and the folder in both directions", async function () {
        const id = this.blog.id;

        await fs.outputFile(join(dir, "missing.txt"), "from source");
        await fs.outputFile(join(dir, "same.txt"), "same");
        await fs.outputFile(join(dir, "differs.txt"), "source version");
        await fs.outputFile(join(dir, "nested", "deep.txt"), "deep");

        await folder.write(id, "/same.txt", "same");
        await folder.write(id, "/differs.txt", "folder");
        await folder.write(id, "/extra.txt", "extra");
        await folder.write(id, "/extra-dir/inside.txt", "inside");

        await reconcileSource(id, dir);

        expect(await text(id, "/missing.txt")).toBe("from source");
        expect(await text(id, "/same.txt")).toBe("same");
        expect(await text(id, "/differs.txt")).toBe("source version");
        expect(await text(id, "/nested/deep.txt")).toBe("deep");
        expect(await folder.exists(id, "/extra.txt")).toBe(false);
        expect(await folder.exists(id, "/extra-dir")).toBe(false);
        // The source is never changed by a reconcile
        expect(await fs.readFile(join(dir, "differs.txt"), "utf8")).toBe("source version");
        expect(await fs.pathExists(join(dir, "extra.txt"))).toBe(false);
      });

      it("compares names as NFC, so a decomposed source name is kept", async function () {
        const id = this.blog.id;
        const decomposed = "café.txt";
        const composed = "/café.txt";

        await fs.outputFile(join(dir, decomposed), "latte");
        await reconcileSource(id, dir);

        expect(await text(id, composed)).toBe("latte");

        // A second pass finds nothing to change and nothing to remove
        await reconcileSource(id, dir);
        expect(await text(id, composed)).toBe("latte");
        expect(await reconcile(id, dir)).toEqual([]);
      });

      it("drops the entries below a directory which a source file replaces", async function () {
        const id = this.blog.id;

        await folder.write(id, "/x/inner.txt", "inner");
        await fs.outputFile(join(dir, "x"), "now a file");

        const changed = await reconcile(id, dir);

        expect(changed).toContain("/x");
        expect(changed).toContain("/x/inner.txt");
        expect(await text(id, "/x")).toBe("now a file");
        expect(await folder.exists(id, "/x/inner.txt")).toBe(false);
      });

      it("leaves no source directory behind when a copy fails, and copies on retry", async function () {
        const id = this.blog.id;

        await folder.write(id, "/a.txt", "a");
        await folder.write(id, "/b.txt", "b");

        const real = folder.read;
        let calls = 0;
        spyOn(folder, "read").and.callFake(function () {
          calls++;
          if (calls === 2) return Promise.reject(new Error("read failed"));
          return real.apply(folder, arguments);
        });

        let error;
        try {
          await reconcileSource(id, dir);
        } catch (err) {
          error = err;
        }

        expect(error).toBeDefined();
        expect(await fs.pathExists(dir)).toBe(false);
        expect(await fs.pathExists(dir + ".seeding")).toBe(false);

        folder.read.and.callThrough();
        await reconcileSource(id, dir);

        expect(await fs.readFile(join(dir, "a.txt"), "utf8")).toBe("a");
        expect(await fs.readFile(join(dir, "b.txt"), "utf8")).toBe("b");
      });

      it("copies the folder of a blog with no source directory into a new one", async function () {
        const id = this.blog.id;

        await folder.write(id, "/old/post.txt", "existing");
        expect(await fs.pathExists(dir)).toBe(false);

        await reconcileSource(id, dir);

        expect(await fs.readFile(join(dir, "old", "post.txt"), "utf8")).toBe("existing");
        expect(await text(id, "/old/post.txt")).toBe("existing");
      });
    });
  });
});
