const fs = require("fs-extra");
const os = require("os");
const { join } = require("path");
const { promisify } = require("util");
const folder = require("storage/folder");
const localReaddir = require("../sync/util/localReaddir");
const resolveCaseConflicts = require("../../util/resolveCaseConflicts");

// The iCloud client reaches the blog folder through storage/folder. These use
// the real config and a real blog folder.
describe("iCloud client access to the blog folder", function () {
  global.test.blog();

  let outside;

  beforeEach(async function () {
    outside = await fs.mkdtemp(join(os.tmpdir(), "icloud-folder-"));
    spyOn(console, "log");
  });

  afterEach(async function () {
    await fs.remove(outside);
  });

  it("writes a file and removes it again", async function () {
    const blogID = this.blog.id;

    // write and remove tell the macserver afterwards, which is not tested here
    const mocked = ["../sync/util/remoteUpload", "../sync/util/remoteDelete", "../write", "../remove"]
      .map((name) => require.resolve(name));
    const saved = mocked.map((p) => require.cache[p]);

    require(mocked[0]);
    require(mocked[1]);
    require.cache[mocked[0]].exports = async () => {};
    require.cache[mocked[1]].exports = async () => {};
    delete require.cache[mocked[2]];
    delete require.cache[mocked[3]];

    try {
      await promisify(require(mocked[2]))(blogID, "/posts/a.txt", "hello");
      expect((await folder.read(blogID, "/posts/a.txt")).toString()).toBe("hello");

      await promisify(require(mocked[3]))(blogID, "/posts");
      expect(await folder.exists(blogID, "/posts")).toBe(false);
    } finally {
      mocked.forEach((p, i) => {
        if (saved[i]) require.cache[p] = saved[i];
        else delete require.cache[p];
      });
    }
  });

  describe("localReaddir", function () {
    it("lists names, directories and file sizes, and no size for a directory", async function () {
      await folder.write(this.blog.id, "/a.txt", "hello");
      await folder.mkdir(this.blog.id, "/dir");

      const items = await localReaddir(this.blog.id, "/");

      expect(items).toEqual([
        { name: "a.txt", isDirectory: false, size: 5 },
        { name: "dir", isDirectory: true, size: undefined },
      ]);
    });

    it("does not follow a symlink out of the blog folder", async function () {
      await fs.writeFile(join(outside, "secret.txt"), "secret");
      await fs.symlink(join(outside, "secret.txt"), join(this.blogDirectory, "link.txt"));
      await folder.write(this.blog.id, "/a.txt", "hello");

      const names = (await localReaddir(this.blog.id, "/")).map((item) => item.name);

      expect(names).toEqual(["a.txt"]);
    });

    it("rejects with ENOENT for a missing directory", async function () {
      let error;

      try {
        await localReaddir(this.blog.id, "/missing");
      } catch (err) {
        error = err;
      }

      expect(error && error.code).toBe("ENOENT");
    });
  });

  describe("resolveCaseConflicts", function () {
    it("renames a file which differs only by case from another", async function () {
      await folder.write(this.blog.id, "/Post.txt", "upper");
      await folder.write(this.blog.id, "/post.txt", "lower");

      const updated = [];
      await resolveCaseConflicts(this.blog.id, () => {}, async (p) => updated.push(p));

      const names = (await folder.listNames(this.blog.id, "/")).map((e) => e.name);

      expect(names.length).toBe(2);
      expect(names.some((name) => name.includes("(conflict)"))).toBe(true);
      expect(updated).toContain("/");
    });

    it("stops with an AbortError when the signal is aborted", async function () {
      await folder.write(this.blog.id, "/Post.txt", "upper");
      await folder.write(this.blog.id, "/post.txt", "lower");

      const signal = { aborted: false };
      const publish = () => {
        signal.aborted = true;
      };
      let error;
      try {
        await resolveCaseConflicts(this.blog.id, publish, async () => {}, signal);
      } catch (e) {
        error = e;
      }

      expect(error && error.name).toBe("AbortError");
      const names = (await folder.listNames(this.blog.id, "/")).map((e) => e.name);
      expect(names.some((name) => name.includes("(conflict)"))).toBe(true);
      expect(names.length).toBe(2);
    });

    it("merges directories which differ only by case", async function () {
      await folder.write(this.blog.id, "/Photos/a.jpg", "a");
      await folder.write(this.blog.id, "/photos/b.jpg", "b");
      await folder.write(this.blog.id, "/photos/sub/c.jpg", "c");

      await resolveCaseConflicts(this.blog.id, () => {}, async () => {});

      const dirs = (await folder.listNames(this.blog.id, "/")).map((e) => e.name);

      expect(dirs.length).toBe(1);

      const kept = "/" + dirs[0];

      expect((await folder.read(this.blog.id, kept + "/a.jpg")).toString()).toBe("a");
      expect((await folder.read(this.blog.id, kept + "/b.jpg")).toString()).toBe("b");
      expect((await folder.read(this.blog.id, kept + "/sub/c.jpg")).toString()).toBe("c");
    });
  });
});
