const folder = require("../folder");

describe("folder", function () {
  require("blog/tests/util/setup")();

  function run(context, query) {
    return new Promise((resolve, reject) => {
      folder({ blog: context.blog, query: query || {} }, {}, (err, result) => {
        if (err) return reject(err);
        resolve(result);
      });
    });
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
      new RegExp("^%%BLOT_CDN%%/folder/v-[^/]+/" + this.blog.id + "/photo\\.jpg$")
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
        "{{#folder}}{{#contents}}<a href=\"{{{url}}}\">{{name}}</a>{{/contents}}{{/folder}}",
    });

    const html = await this.text("/");
    // middleware may downgrade the origin to http, so ignore the scheme
    const cdn = require("config").cdn.origin.replace(/^https?:\/\//, "");
    const escaped = cdn.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    expect(html).toMatch(
      new RegExp(
        '<a href="https?://' + escaped + "/folder/v-[^/]+/" + this.blog.id + '/photo\\.jpg">photo.jpg</a>'
      )
    );
    expect(html).toContain('<a href="/sub">sub</a>');
    expect(html).not.toContain("%%BLOT_CDN%%");
  });
});
