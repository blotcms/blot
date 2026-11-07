const folder = require("../folder");
const fs = require("fs-extra");
const os = require("os");
const storage = require("storage/folder");
const contentVersion = require("helper/contentVersion");

describe("folder", function () {
  require("blog/tests/util/setup")();

  function run(context, query) {
    return folder({ blog: context.blog, query: query || {} }, {});
  }

  it("lists files and directories at the root of the blog folder", async function () {
    await this.write({ path: "/a.txt", content: "Hello" });
    await this.write({ path: "/sub/b.txt", content: "World" });

    const result = await run(this, {});

    const names = result.contents.map((item) => item.name).sort();
    expect(names).toEqual(["a.txt", "sub"]);

    const file = result.contents.find((item) => item.name === "a.txt");
    expect(file.isFile).toBe(true);
    expect(file.isDirectory).toBe(false);
    expect(file.path).toEqual("/a.txt");
    expect(file.pathURI).toEqual(encodeURIComponent("/a.txt"));

    const dir = result.contents.find((item) => item.name === "sub");
    expect(dir.isDirectory).toBe(true);
    expect(dir.isFile).toBe(false);
  });

  it("lists the contents of a subdirectory and exposes its parent", async function () {
    await this.write({ path: "/sub/b.txt", content: "World" });

    const result = await run(this, { path: "/sub" });

    expect(result.contents.map((item) => item.name)).toEqual(["b.txt"]);
    expect(result.parent).toEqual("/");
  });

  it("filters out dotfiles", async function () {
    await this.write({ path: "/.hidden", content: "secret" });
    await this.write({ path: "/visible.txt", content: "Hello" });

    const result = await run(this, {});

    expect(result.contents.map((item) => item.name)).toEqual(["visible.txt"]);
  });

  it("sorts contents in natural alphanumeric order, not filesystem order", async function () {
    await this.write({ path: "/b.txt", content: "B" });
    await this.write({ path: "/a.txt", content: "A" });
    await this.write({ path: "/10.txt", content: "10" });
    await this.write({ path: "/2.txt", content: "2" });

    const result = await run(this, {});

    expect(result.contents.map((item) => item.name)).toEqual([
      "2.txt",
      "10.txt",
      "a.txt",
      "b.txt",
    ]);
  });

  it("returns an empty list when the requested path does not exist", async function () {
    const result = await run(this, { path: "/does-not-exist" });

    expect(result).toEqual([]);
  });

  it("gives files a versioned CDN url and directories a plain url", async function () {
    await this.write({ path: "/photo.jpg", content: "img" });
    await this.write({ path: "/sub/b.txt", content: "World" });
    await this.write({ path: "/page.html", content: "<p>hi</p>" });
    await this.write({ path: "/README", content: "plain" });

    const result = await run(this, {});
    const byName = (name) => result.contents.find((item) => item.name === name);

    expect(byName("photo.jpg").url).toMatch(
      new RegExp(
        "^%%BLOT_CDN%%/folder/v-[^/]+/" + this.blog.id + "/photo\\.jpg$"
      )
    );
    expect(byName("sub").url).toEqual("/sub");
    expect(byName("page.html").url).toEqual("/page.html");
    expect(byName("README").url).toEqual("/README");
    expect(byName("photo.jpg").path).toEqual("/photo.jpg");
  });

  it("renders file links pointing at the CDN and directory links plain", async function () {
    await this.write({ path: "/photo.jpg", content: "img" });
    await this.write({ path: "/sub/b.txt", content: "World" });
    await this.template({
      "entries.html":
        '{{#folder}}{{#contents}}<a href="{{{url}}}">{{name}}</a>{{/contents}}{{/folder}}',
    });

    const html = await this.text("/");
    // middleware may downgrade the origin to http, so ignore the scheme
    const cdn = require("config").cdn.origin.replace(/^https?:\/\//, "");
    const escaped = cdn.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    expect(html).toMatch(
      new RegExp(
        '<a href="https?://' +
          escaped +
          "/folder/v-[^/]+/" +
          this.blog.id +
          '/photo\\.jpg">photo.jpg</a>'
      )
    );
    expect(html).toContain('<a href="/sub">sub</a>');
    expect(html).not.toContain("%%BLOT_CDN%%");
  });

  it("versions a file's CDN url exactly as contentVersion.fromFolderStat does", async function () {
    const modified = 1700000000123;
    const local = os.tmpdir() + "/retrieve-folder-" + this.blog.id + ".jpg";

    await fs.outputFile(local, "img");
    await storage.writeFrom(this.blog.id, "/photo.jpg", local, { modified });
    await fs.remove(local);

    const stat = await storage.stat(this.blog.id, "/photo.jpg");
    const result = await run(this, {});
    const item = result.contents.find((item) => item.name === "photo.jpg");

    expect(item.url).toEqual(
      "%%BLOT_CDN%%/folder/v-" +
        contentVersion.fromFolderStat(stat) +
        "/" +
        this.blog.id +
        "/photo.jpg"
    );
    expect(item.updated).toEqual(new Date(Math.round(stat.modified)));
    expect(item.updated instanceof Date).toBe(true);
  });

  it("returns an empty list for a file, an array or a traversal", async function () {
    await this.write({ path: "/a.txt", content: "Hello" });

    expect(await run(this, { path: "/a.txt" })).toEqual([]);
    expect(await run(this, { path: ["/a", "/b"] })).toEqual([]);
    expect(await run(this, { path: { a: "b" } })).toEqual([]);
    expect(await run(this, { path: "/../../../../etc" })).toEqual([]);
  });
});
