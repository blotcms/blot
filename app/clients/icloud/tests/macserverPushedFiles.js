// The macserver skips pushing a file whose size and mtime haven't changed since
// it was last pushed (iCloud evicting or re-materialising a file is reported
// as a change). Like macserverDisconnect.js, a resolve hook stubs dotenv and,
// for httpClient/upload.js only, swaps brctl and fetch for spies held on
// globalThis.__pushedFilesMocks.
const fs = require("fs-extra");
const os = require("os");
const path = require("path");
const { register } = require("module");
const { pathToFileURL } = require("url");

const macserverDir = path.join(__dirname, "../macserver");
const load = (file) => import(pathToFileURL(path.join(macserverDir, file)).href);

const hooks = `
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "dotenv/config") {
    try {
      return await nextResolve(specifier, context);
    } catch (e) {
      return { url: "data:text/javascript,", shortCircuit: true };
    }
  }
  if (context.parentURL && context.parentURL.endsWith("/httpClient/upload.js")) {
    if (specifier === "../brctl/index.js") {
      return {
        url: "data:text/javascript,export const download = (...args) => globalThis.__pushedFilesMocks.download(...args)",
        shortCircuit: true,
      };
    }
    if (specifier === "./rateLimitedFetchWithRetriesAndTimeout.js") {
      return {
        url: "data:text/javascript,export default (...args) => globalThis.__pushedFilesMocks.fetch(...args)",
        shortCircuit: true,
      };
    }
  }
  return nextResolve(specifier, context);
}
`;

describe("icloud macserver pushed files", function () {
  let pushedFiles;
  let upload;
  let iCloudDriveDirectory;
  let blogCounter = 0;

  const newBlogID = () => `blog_pushed_${process.pid}_${blogCounter++}`;
  const stat = (size, mtimeMs) => ({ size, mtimeMs });

  beforeAll(async function () {
    register("data:text/javascript," + encodeURIComponent(hooks));

    // config.js reads these when it is first imported, and may already have
    // been imported by another spec with the same directory
    const env = {
      REMOTE_SERVER: "http://127.0.0.1:1",
      ICLOUD_DRIVE_DIRECTORY: os.tmpdir(),
      BLOT_ICLOUD_SERVER_SECRET: "test-secret",
    };
    const previous = {};
    for (const key in env) {
      previous[key] = process.env[key];
      if (process.env[key] === undefined) process.env[key] = env[key];
    }

    globalThis.__pushedFilesMocks = {};
    try {
      pushedFiles = await load("pushedFiles.js");
      upload = (await load("httpClient/upload.js")).default;
      iCloudDriveDirectory = (await load("config.js")).iCloudDriveDirectory;
    } finally {
      for (const key in previous) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
    }
  });

  afterAll(function () {
    delete globalThis.__pushedFilesMocks;
  });

  beforeEach(function () {
    spyOn(console, "log");
    spyOn(console, "warn");
    spyOn(console, "error");
  });

  describe("pushedFiles", function () {
    it("reports a file unchanged only while its size and mtime match the last push", function () {
      const blogID = newBlogID();

      expect(pushedFiles.isUnchanged(blogID, "a.md", stat(10, 1000))).toBe(false);

      pushedFiles.recordPushed(blogID, "a.md", stat(10, 1000));

      expect(pushedFiles.isUnchanged(blogID, "a.md", stat(10, 1000))).toBe(true);
      expect(pushedFiles.isUnchanged(blogID, "a.md", stat(10, 2000))).toBe(false);
      expect(pushedFiles.isUnchanged(blogID, "a.md", stat(11, 1000))).toBe(false);
      expect(pushedFiles.isUnchanged(newBlogID(), "a.md", stat(10, 1000))).toBe(false);
    });

    it("forgets a removed directory's contents but not a sibling sharing its prefix", function () {
      const blogID = newBlogID();
      for (const p of ["dir", "dir/a.md", "dir/sub/b.md", "dir2/c.md", "other.md"]) {
        pushedFiles.recordPushed(blogID, p, stat(1, 1));
      }

      pushedFiles.forgetPath(blogID, "dir");

      expect(pushedFiles.isUnchanged(blogID, "dir/a.md", stat(1, 1))).toBe(false);
      expect(pushedFiles.isUnchanged(blogID, "dir/sub/b.md", stat(1, 1))).toBe(false);
      expect(pushedFiles.isUnchanged(blogID, "dir2/c.md", stat(1, 1))).toBe(true);
      expect(pushedFiles.isUnchanged(blogID, "other.md", stat(1, 1))).toBe(true);
    });

    it("forgets a whole blog", function () {
      const blogID = newBlogID();
      const otherBlogID = newBlogID();
      pushedFiles.recordPushed(blogID, "a.md", stat(1, 1));
      pushedFiles.recordPushed(otherBlogID, "a.md", stat(1, 1));

      pushedFiles.forgetBlog(blogID);

      expect(pushedFiles.isUnchanged(blogID, "a.md", stat(1, 1))).toBe(false);
      expect(pushedFiles.isUnchanged(otherBlogID, "a.md", stat(1, 1))).toBe(true);
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

      fetch.and.callFake(async () => ({ ok: true, status: 200, text: async () => "ok" }));
      await upload(blogID, "post.md");

      expect(fetch).toHaveBeenCalledTimes(2);
    });

    it("pushes again after the path is forgotten", async function () {
      await upload(blogID, "post.md");
      pushedFiles.forgetPath(blogID, "post.md");
      await upload(blogID, "post.md");

      expect(fetch).toHaveBeenCalledTimes(2);
    });
  });
});
