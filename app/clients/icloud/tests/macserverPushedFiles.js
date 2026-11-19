// The macserver skips pushing a file whose size and mtime haven't changed since
// it was last pushed (iCloud evicting or re-materialising a file is reported
// as a change). Like macserverDisconnect.js, a resolve hook stubs dotenv and,
// for httpClient/upload.js and downloadBirdsVersion.js only, swaps brctl,
// bird's database and fetch for spies held on globalThis.__pushedFilesMocks
// and config.js for a stub, so this spec never caches the config.js other
// specs set up through process.env.
const fs = require("fs-extra");
const os = require("os");
const path = require("path");
const { register } = require("module");
const { pathToFileURL } = require("url");

const macserverDir = path.join(__dirname, "../macserver");
const load = (file) =>
  import(pathToFileURL(path.join(macserverDir, file)).href);

const iCloudDriveDirectory = path.join(
  os.tmpdir(),
  `macserver-pushed-${process.pid}`
);

const hooks = `
const ICLOUD_DRIVE_DIRECTORY = ${JSON.stringify(iCloudDriveDirectory)};
const BRCTL = "data:text/javascript," + encodeURIComponent(
  "export const download = (...args) => globalThis.__pushedFilesMocks.download(...args);" +
  "export const evict = async () => {};"
);
const BIRD = "data:text/javascript," + encodeURIComponent(
  "export const fileVersion = async (...args) => (globalThis.__pushedFilesMocks.fileVersion || (() => null))(...args);" +
  "export const diskMatches = (v, s) => s.size === v.size && Math.floor(s.mtimeMs / 1000) === v.mtime;"
);
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "dotenv/config") {
    try {
      return await nextResolve(specifier, context);
    } catch (e) {
      return { url: "data:text/javascript,", shortCircuit: true };
    }
  }
  if (context.parentURL && context.parentURL.endsWith("/httpClient/upload.js")) {
    if (specifier === "../config.js") {
      return {
        url: "data:text/javascript," + encodeURIComponent(
          "export const remoteServer = 'http://127.0.0.1:1';" +
          "export const Authorization = 'test-secret';" +
          "export const iCloudDriveDirectory = " + JSON.stringify(ICLOUD_DRIVE_DIRECTORY) + ";" +
          "export const maxFileSize = 1024 * 1024;"
        ),
        shortCircuit: true,
      };
    }
    if (specifier === "../brctl/index.js") {
      return { url: BRCTL, shortCircuit: true };
    }
    if (specifier === "../birdState.js") {
      return { url: BIRD, shortCircuit: true };
    }
    if (specifier === "./rateLimitedFetchWithRetriesAndTimeout.js") {
      return {
        url: "data:text/javascript,export default (...args) => globalThis.__pushedFilesMocks.fetch(...args)",
        shortCircuit: true,
      };
    }
  }
  if (context.parentURL && context.parentURL.endsWith("/downloadBirdsVersion.js")) {
    if (specifier === "./brctl/index.js") {
      return { url: BRCTL, shortCircuit: true };
    }
    if (specifier === "./birdState.js") {
      return { url: BIRD, shortCircuit: true };
    }
  }
  return nextResolve(specifier, context);
}
`;

describe("icloud macserver pushed files", function () {
  let pushedFiles;
  let upload;
  let blogCounter = 0;

  const newBlogID = () => `blog_pushed_${process.pid}_${blogCounter++}`;
  const stat = (size, mtimeMs) => ({ size, mtimeMs });

  beforeAll(async function () {
    register("data:text/javascript," + encodeURIComponent(hooks));

    globalThis.__pushedFilesMocks = {};
    pushedFiles = await load("pushedFiles.js");
    upload = (await load("httpClient/upload.js")).default;
  });

  afterAll(async function () {
    delete globalThis.__pushedFilesMocks;
    await fs.remove(iCloudDriveDirectory);
  });

  beforeEach(function () {
    spyOn(console, "log");
    spyOn(console, "warn");
    spyOn(console, "error");
  });

  describe("pushedFiles", function () {
    it("reports a file unchanged only while its size and mtime match the last push", function () {
      const blogID = newBlogID();

      expect(pushedFiles.isUnchanged(blogID, "a.md", stat(10, 1000))).toBe(
        false
      );

      pushedFiles.recordPushed(blogID, "a.md", stat(10, 1000));

      expect(pushedFiles.isUnchanged(blogID, "a.md", stat(10, 1000))).toBe(
        true
      );
      expect(pushedFiles.isUnchanged(blogID, "a.md", stat(10, 2000))).toBe(
        false
      );
      expect(pushedFiles.isUnchanged(blogID, "a.md", stat(11, 1000))).toBe(
        false
      );
      expect(pushedFiles.isUnchanged(newBlogID(), "a.md", stat(10, 1000))).toBe(
        false
      );
    });

    it("forgets a removed directory's contents but not a sibling sharing its prefix", function () {
      const blogID = newBlogID();
      for (const p of [
        "dir",
        "dir/a.md",
        "dir/sub/b.md",
        "dir2/c.md",
        "other.md",
      ]) {
        pushedFiles.recordPushed(blogID, p, stat(1, 1));
      }

      pushedFiles.forgetPath(blogID, "dir");

      expect(pushedFiles.isUnchanged(blogID, "dir/a.md", stat(1, 1))).toBe(
        false
      );
      expect(pushedFiles.isUnchanged(blogID, "dir/sub/b.md", stat(1, 1))).toBe(
        false
      );
      expect(pushedFiles.isUnchanged(blogID, "dir2/c.md", stat(1, 1))).toBe(
        true
      );
      expect(pushedFiles.isUnchanged(blogID, "other.md", stat(1, 1))).toBe(
        true
      );
    });

    it("forgets a whole blog", function () {
      const blogID = newBlogID();
      const otherBlogID = newBlogID();
      pushedFiles.recordPushed(blogID, "a.md", stat(1, 1));
      pushedFiles.recordPushed(otherBlogID, "a.md", stat(1, 1));

      pushedFiles.forgetBlog(blogID);

      expect(pushedFiles.isUnchanged(blogID, "a.md", stat(1, 1))).toBe(false);
      expect(pushedFiles.isUnchanged(otherBlogID, "a.md", stat(1, 1))).toBe(
        true
      );
    });

    it("starts tracking a blog once, until it is forgotten", function () {
      const blogID = newBlogID();

      expect(pushedFiles.startTracking(blogID)).toBe(true);
      expect(pushedFiles.startTracking(blogID)).toBe(false);

      pushedFiles.forgetBlog(blogID);
      expect(pushedFiles.startTracking(blogID)).toBe(true);
      pushedFiles.forgetBlog(blogID);
    });

    it("does not start tracking a blog it has already recorded a push for", function () {
      const blogID = newBlogID();
      pushedFiles.recordPushed(blogID, "a.md", stat(1, 1));

      expect(pushedFiles.startTracking(blogID)).toBe(false);
      pushedFiles.forgetBlog(blogID);
    });

    it("drops a blog's oldest entries past the cap", function () {
      const blogID = newBlogID();
      const max = pushedFiles.MAX_ENTRIES_PER_BLOG;
      for (let i = 0; i <= max; i++) {
        pushedFiles.recordPushed(blogID, `f${i}`, stat(1, 1));
      }

      expect(pushedFiles.isUnchanged(blogID, "f0", stat(1, 1))).toBe(false);
      expect(pushedFiles.isUnchanged(blogID, "f1", stat(1, 1))).toBe(true);
      expect(pushedFiles.isUnchanged(blogID, `f${max}`, stat(1, 1))).toBe(true);
      pushedFiles.forgetBlog(blogID);
    });
  });

  describe("upload", function () {
    let blogID;
    let filePath;
    let download;
    let fetch;

    beforeEach(async function () {
      blogID = newBlogID();
      filePath = path.join(iCloudDriveDirectory, blogID, "post.md");
      await fs.outputFile(filePath, "Hello");

      download = jasmine.createSpy("download").and.callFake((p) => fs.stat(p));
      fetch = jasmine.createSpy("fetch").and.callFake(async () => ({
        ok: true,
        status: 200,
        text: async () => "ok",
      }));
      globalThis.__pushedFilesMocks.download = download;
      globalThis.__pushedFilesMocks.fetch = fetch;
    });

    afterEach(async function () {
      delete globalThis.__pushedFilesMocks.fileVersion;
      pushedFiles.forgetBlog(blogID);
      await fs.remove(path.join(iCloudDriveDirectory, blogID));
    });

    it("skips a file unchanged since it was pushed, without downloading it", async function () {
      await upload(blogID, "post.md");
      expect(download).toHaveBeenCalledTimes(1);
      expect(fetch).toHaveBeenCalledTimes(1);

      await upload(blogID, "post.md");
      expect(download).toHaveBeenCalledTimes(1);
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it("pushes the file again once its mtime changes", async function () {
      await upload(blogID, "post.md");

      const later = new Date(Date.now() + 60 * 1000);
      await fs.utimes(filePath, later, later);
      await upload(blogID, "post.md");

      expect(fetch).toHaveBeenCalledTimes(2);
    });

    it("does not record a push Blot refused", async function () {
      fetch.and.callFake(async () => ({
        ok: false,
        status: 500,
        text: async () => "error",
      }));

      await expectAsync(upload(blogID, "post.md")).toBeRejected();

      fetch.and.callFake(async () => ({
        ok: true,
        status: 200,
        text: async () => "ok",
      }));
      await upload(blogID, "post.md");

      expect(fetch).toHaveBeenCalledTimes(2);
    });

    // bird has a version the disk doesn't yet: a forced download brings it
    const birdHas = async (contents, seconds) => {
      globalThis.__pushedFilesMocks.fileVersion = async () => ({
        size: Buffer.byteLength(contents),
        mtime: seconds,
      });
      download.and.callFake(async (p, options) => {
        if (options && options.force) {
          await fs.outputFile(p, contents);
          await fs.utimes(p, seconds, seconds);
        }
        return fs.stat(p);
      });
    };
    const pushedBytes = (call) => fetch.calls.argsFor(call)[1].body.length;

    it("waits for the disk to reach the version bird has", async function () {
      await birdHas("Hello, world", 1700000000);

      await upload(blogID, "post.md");

      expect(fetch).toHaveBeenCalledTimes(1);
      expect(pushedBytes(0)).toBe("Hello, world".length);
    });

    it("does not skip a file as unchanged while bird has a newer version", async function () {
      await upload(blogID, "post.md");
      expect(fetch).toHaveBeenCalledTimes(1);

      await birdHas("Hello again", 1700000100);
      await upload(blogID, "post.md");

      expect(fetch).toHaveBeenCalledTimes(2);
      expect(pushedBytes(1)).toBe("Hello again".length);
    });

    it("gives a new file whose record is empty a moment to fill in", async function () {
      await fs.outputFile(filePath, "");
      await fs.utimes(filePath, 1700000200, 1700000200);
      let calls = 0;
      globalThis.__pushedFilesMocks.fileVersion = async () =>
        ++calls < 2
          ? { size: 0, mtime: 1700000200 }
          : { size: 5, mtime: 1700000201 };
      download.and.callFake(async (p) => {
        if (calls >= 2) {
          await fs.outputFile(p, "Hello");
          await fs.utimes(p, 1700000201, 1700000201);
        }
        return fs.stat(p);
      });

      await upload(blogID, "post.md");

      expect(pushedBytes(0)).toBe(5);
    });

    it("pushes again after the path is forgotten", async function () {
      await upload(blogID, "post.md");
      pushedFiles.forgetPath(blogID, "post.md");
      await upload(blogID, "post.md");

      expect(fetch).toHaveBeenCalledTimes(2);
    });
  });
});
