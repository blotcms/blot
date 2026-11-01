const fs = require("fs").promises;
const fsExtra = require("fs-extra");
const path = require("path");
const os = require("os");
const vm = require("vm");
const express = require("express");
const caseSensitivePath = require("util").promisify(
  require("helper/caseSensitivePath")
);

// Covers the order the blog-folder middleware tries candidates in once the
// exact path has missed, and that every candidate keeps the no-symlink policy.
describe("blog asset fallbacks", function () {
  let dir, blog, server, url, readdirs;

  async function write(name, content = name) {
    await fs.mkdir(path.dirname(path.join(blog, name)), { recursive: true });
    await fs.writeFile(path.join(blog, name), content);
  }

  async function text(pathname) {
    const response = await fetch(url + pathname);
    return response.status === 200 ? await response.text() : response.status;
  }

  beforeEach(async function () {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "blot-assets-fallbacks-"));
    blog = path.join(dir, "blogs", "test");
    await fs.mkdir(blog, { recursive: true });
    readdirs = 0;
    const module = { exports: {} };
    const config = {
      blog_folder_dir: path.join(dir, "blogs"),
      blot_directory: dir,
    };
    const countingFs = {
      ...fsExtra,
      readdir: (...args) => {
        readdirs++;
        return fsExtra.readdir(...args);
      },
    };
    vm.runInNewContext(
      await fs.readFile(require.resolve("../routes/assets"), "utf8"),
      {
        module,
        exports: module.exports,
        require: (name) =>
          name === "config"
            ? config
            : name === "fs-extra"
            ? countingFs
            : require(name),
      }
    );
    const app = express();
    app.use((req, res, next) => {
      req.blog = { id: "test" };
      next();
    });
    app.use(module.exports);
    app.use((req, res) => res.sendStatus(404));
    server = await new Promise((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    url = "http://127.0.0.1:" + server.address().port;
  });

  afterEach(async function () {
    if (server) await new Promise((resolve) => server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("answers a miss under a missing directory with a single directory read", async function () {
    await write("present.txt");
    expect(await text("/wp-admin/setup/config.txt")).toBe(404);
    expect(readdirs).toBe(1);
  });

  it("tries the lowercased path when the case-insensitive walk dead-ends", async function () {
    await fs.mkdir(path.join(blog, "Docs"));
    await write("docs/sub/page.txt", "lower");
    expect(await text("/Docs/sub/page.txt")).toBe("lower");
  });

  it("answers a path which is not valid percent-encoding when decoded twice", async function () {
    expect(await text("/100%25")).toBe(404);
    await write("100%.html", "page");
    expect(await text("/100%25")).toBe("page");
  });

  it("prefers the exact name when two names differ only by case", async function () {
    await write("Foo.png", "upper");
    await write("foo.png", "lower");
    expect(await text("/Foo.png")).toBe("upper");
    expect(await text("/foo.png")).toBe("lower");
    // the lowercased path is tried before any other casing
    expect(await text("/FOO.png")).toBe("lower");
    expect(await text("/FOO.PNG")).toBe("lower");
  });

  it("picks the same file as caseSensitivePath when several match", async function () {
    await write("Pic.txt", "one");
    await write("PIC.txt", "two");
    await write("pIC.txt", "three");
    const expected = await fs.readFile(
      await caseSensitivePath(blog, "/pic.TXT"),
      "utf8"
    );
    expect(await text("/pic.TXT")).toBe(expected);
  });

  it("matches directories and names ignoring case, including non-ASCII", async function () {
    await write("Été/Café.txt", "accents");
    expect(await text("/été/CAFÉ.txt")).toBe("accents");
    expect(await text("/%C3%89t%C3%A9/Caf%C3%A9.txt")).toBe("accents");
  });

  it("finds a lowercase directory when a differently cased file shares its name", async function () {
    await write("Docs", "a file");
    await write("docs/page.txt", "in the directory");
    expect(await text("/DOCS/page.txt")).toBe("in the directory");
  });

  it("does not serve a directory which matches by case where a file is expected", async function () {
    await fs.mkdir(path.join(blog, "Docs.txt"));
    expect(await text("/docs.txt")).toBe(404);
    expect(await text("/Docs.txt")).toBe(404);
    await write("Docs.txt.html", "page");
    expect(await text("/Docs.txt")).toBe("page");
  });

  it("serves a directory's index.html before the .html file of the same name", async function () {
    await write("about.html", "file");
    await write("about/index.html", "index");
    expect(await text("/about")).toBe("index");
    expect(await text("/about/")).toBe("index");
  });

  it("prefers _index.html in a directory over name.html", async function () {
    await write("about.html", "file");
    await write("about/_index.html", "underscore index");
    expect(await text("/about")).toBe("underscore index");
  });

  it("prefers name.html over _name.html", async function () {
    await write("about.html", "file");
    await write("_about.html", "underscore file");
    expect(await text("/about")).toBe("file");
  });

  it("falls back to _name.html, with or without a trailing slash", async function () {
    await write("dir/_about.html", "underscore file");
    expect(await text("/dir/about")).toBe("underscore file");
    expect(await text("/dir/about/")).toBe("underscore file");
  });

  it("serves name.html for a trailing slash", async function () {
    await write("about.html", "file");
    expect(await text("/about/")).toBe("file");
  });

  it("only looks for the .html fallbacks with the exact casing", async function () {
    await write("about.html", "file");
    await write("Dir/index.html", "index");
    expect(await text("/ABOUT")).toBe(404);
    expect(await text("/dir")).toBe(404);
    expect(await text("/Dir")).toBe("index");
  });

  it("serves a file named like a directory's index only when it is a file", async function () {
    await fs.mkdir(path.join(blog, "about/index.html"), { recursive: true });
    await write("about.html", "file");
    expect(await text("/about")).toBe("file");
  });

  it("serves dotfiles and dot directories through the fallbacks", async function () {
    await write(".well-known/Security.txt", "dot dir");
    await write(".page.html", "dot page");
    expect(await text("/.well-known/security.txt")).toBe("dot dir");
    expect(await text("/.page")).toBe("dot page");
  });

  it("resolves a percent-encoded name to a .html file", async function () {
    await write("my page.html", "spaced");
    expect(await text("/my%20page")).toBe("spaced");
  });

  it("serves a request which matches a file exactly without a case fallback", async function () {
    await write("Exact.txt", "exact");
    await write("exact.txt", "other");
    expect(await text("/Exact.txt")).toBe("exact");
  });

  describe("symlinks", function () {
    beforeEach(async function () {
      await write("real.html", "real");
      await write("real/index.html", "real index");
    });

    it("rejects a symlink at each fallback candidate", async function () {
      await fs.symlink("real.html", path.join(blog, "linked.html"));
      await fs.symlink("real.html", path.join(blog, "_underscored.html"));
      await fs.mkdir(path.join(blog, "indexed"));
      await fs.symlink("../real.html", path.join(blog, "indexed/index.html"));
      await fs.mkdir(path.join(blog, "uindexed"));
      await fs.symlink("../real.html", path.join(blog, "uindexed/_index.html"));
      await fs.symlink("real.html", path.join(blog, "Cased.txt"));
      await fs.symlink("real.html", path.join(blog, "lowered.txt"));

      for (const pathname of [
        "/linked",
        "/linked/",
        "/underscored",
        "/indexed",
        "/indexed/",
        "/uindexed",
        "/CASED.txt",
        "/cased.txt",
        "/LOWERED.TXT",
      ]) {
        expect(await text(pathname)).withContext(pathname).toBe(404);
      }
    });

    it("rejects a symlinked directory on the way to any candidate", async function () {
      await fs.symlink("real", path.join(blog, "ancestor"));
      await fs.symlink("real", path.join(blog, "Upper"));
      await fs.symlink(".", path.join(blog, "self"));
      await write("real/page.html", "page");
      await write("real/_other.html", "other");

      for (const pathname of [
        "/ancestor",
        "/ancestor/",
        "/ancestor/page",
        "/ancestor/other",
        "/ancestor/INDEX.html",
        "/upper/page",
        "/UPPER/PAGE.html",
        "/self/real",
        "/self/real.html",
      ]) {
        expect(await text(pathname)).withContext(pathname).toBe(404);
      }
    });

    it("skips a symlink to continue to a later real candidate", async function () {
      await fs.symlink("real.html", path.join(blog, "both.html"));
      await write("_both.html", "underscore file");
      expect(await text("/both")).toBe("underscore file");
    });

    it("serves a real directory matched ignoring case", async function () {
      await write("Sub/file.txt", "real");
      expect(await text("/sub/file.txt")).toBe("real");
    });
  });
});
