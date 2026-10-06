describe("folder links in templates", function () {
  require("blog/tests/util/setup")();

  const config = require("config");
  const crypto = require("crypto");
  const BLOT_CDN_TOKEN = require("blog/render/replaceFolderLinks/cdnToken");

  // The version of a file's content, as baked into /folder/v-<version>/ URLs.
  // Request-time rewriting versions by size and mtime instead, so a match
  // here means the template's own manifest produced the URL.
  const version = (content) =>
    crypto.createHash("sha1").update(content).digest("hex").slice(0, 8);

  const folderUrl = (blog, content, path) =>
    `${config.cdn.origin}/folder/v-${version(content)}/${blog.id}${path}`;

  it("rewrites a literal link in a template to a versioned CDN URL", async function () {
    await this.write({ path: "/a.png", content: "one" });
    await this.template({ "entries.html": '<img src="/a.png">' });

    const body = await this.text("/");

    expect(body).toBe(`<img src="${folderUrl(this.blog, "one", "/a.png")}">`);
    expect(body).not.toContain(BLOT_CDN_TOKEN);
  });

  it("serves the file from the CDN", async function () {
    await this.write({ path: "/a.png", content: "one" });
    await this.template({ "entries.html": '<img src="/a.png">' });

    const url = (await this.text("/")).split('"')[1];

    expect(await this.text(url)).toBe("one");
  });

  it("rewrites every kind of link", async function () {
    await this.write({ path: "/a.png", content: "one" });
    await this.write({ path: "/b.png", content: "two" });
    await this.template({
      "entries.html": [
        '<img src="/a.png" srcset="/a.png 1x, /b.png 2x">',
        '<meta property="og:image" content="{{{blog.url}}}/b.png">',
        '<div style="background:url(/a.png)"></div>',
        "<style>p{background:url('/b.png')}</style>",
        `<img src="https://${this.blog.handle}.${config.host}/a.png">`,
      ].join("\n"),
    });

    const a = folderUrl(this.blog, "one", "/a.png");
    const b = folderUrl(this.blog, "two", "/b.png");

    expect(await this.text("/")).toBe(
      [
        `<img src="${a}" srcset="${a} 1x, ${b} 2x">`,
        `<meta property="og:image" content="${b}">`,
        `<div style="background:url(${a})"></div>`,
        `<style>p{background:url('${b}')}</style>`,
        `<img src="${a}">`,
      ].join("\n")
    );
  });

  it("gives a changed file a new URL", async function () {
    await this.write({ path: "/a.png", content: "one" });
    await this.template({ "entries.html": '<img src="/a.png">' });

    expect(await this.text("/")).toContain(folderUrl(this.blog, "one", "/a.png"));

    await this.write({ path: "/a.png", content: "two" });

    expect(await this.text("/")).toBe(
      `<img src="${folderUrl(this.blog, "two", "/a.png")}">`
    );
  });

  it("rewrites a link to a file that is created later", async function () {
    await this.template({ "entries.html": '<img src="/late.png">' });

    expect(await this.text("/")).toBe('<img src="/late.png">');

    await this.write({ path: "/late.png", content: "one" });

    expect(await this.text("/")).toBe(
      `<img src="${folderUrl(this.blog, "one", "/late.png")}">`
    );
  });

  it("goes back to the plain link when the file is deleted", async function () {
    await this.write({ path: "/a.png", content: "one" });
    await this.template({ "entries.html": '<img src="/a.png">' });

    expect(await this.text("/")).toContain("/folder/v-");

    await this.remove("/a.png");

    expect(await this.text("/")).toBe('<img src="/a.png">');
  });

  it("rewrites a link whose file is in the folder under a different case", async function () {
    await this.write({ path: "/Photos/Beach.JPG", content: "one" });
    await this.template({ "entries.html": '<img src="/photos/beach.jpg">' });

    const body = await this.text("/");

    expect(body.toLowerCase()).toBe(
      `<img src="${folderUrl(this.blog, "one", "/photos/beach.jpg")}">`.toLowerCase()
    );
  });

  it("leaves other links alone", async function () {
    const html =
      '<a href="/about">About</a><a href="https://example.com/a.png">x</a><a href="mailto:a@b.co">m</a><a href="/page.html">p</a><img src="data:image/gif;base64,R0lGOD">';

    await this.template({ "entries.html": html });

    expect(await this.text("/")).toBe(html);
  });

  it("does not rewrite links on a preview subdomain", async function () {
    await this.write({ path: "/a.png", content: "one" });
    await this.template({ "entries.html": '<img src="/a.png">' });

    const preview = await this.fetch(
      config.protocol + "preview-of-my-local-on-" + this.blog.handle + "." + config.host
    );

    expect(await preview.text()).toBe('<img src="/a.png">');
  });

  describe("CSS", function () {
    const views = {
      "entries.html": '<link rel="stylesheet" href="{{#cdn}}/style.css{{/cdn}}">',
      "style.css": "a{background:url(img/a.png)}",
    };

    const css = async (test) => {
      const href = (await test.text("/")).match(/href="([^"]+)"/)[1];
      return test.text(href);
    };

    it("resolves a relative url() against the stylesheet's own url", async function () {
      await this.write({ path: "/css/img/a.png", content: "correct" });
      await this.template(views, { views: { "style.css": { url: "/css/style.css" } } });

      expect(await css(this)).toContain(
        folderUrl(this.blog, "correct", "/css/img/a.png")
      );
    });

    it("falls back to the root-relative file", async function () {
      await this.write({ path: "/img/a.png", content: "root" });
      await this.template(views, { views: { "style.css": { url: "/css/style.css" } } });

      expect(await css(this)).toContain(
        folderUrl(this.blog, "root", "/img/a.png")
      );
    });

    it("gives the stylesheet a new URL when an image changes", async function () {
      await this.write({ path: "/img/a.png", content: "one" });
      await this.template(views);

      const before = (await this.text("/")).match(/href="([^"]+)"/)[1];

      await this.write({ path: "/img/a.png", content: "two" });

      const after = (await this.text("/")).match(/href="([^"]+)"/)[1];

      expect(after).not.toBe(before);
      expect(await this.text(after)).toContain(
        folderUrl(this.blog, "two", "/img/a.png")
      );
    });
  });

  it("still rewrites, at request time, the links the template can't wrap", async function () {
    await this.write({ path: "/a.png", content: "one" });
    await this.template(
      { "entries.html": "{{> x}}" },
      { views: { "entries.html": { partials: { x: '<img src="/a.png">' } } } }
    );

    expect(await this.text("/")).toMatch(
      new RegExp(`${config.cdn.origin}/folder/v-[a-f0-9]{8}/${this.blog.id}/a.png`)
    );
  });
});
