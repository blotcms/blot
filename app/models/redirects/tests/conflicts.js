describe("redirects.conflicts", function () {
  const fs = require("fs-extra");
  const { promisify } = require("util");
  const build = require("build");
  const Entry = require("models/entry");
  const Template = require("models/template");
  const conflicts = promisify(require("../conflicts"));

  global.test.blog();

  beforeEach(function () {
    // Returns the conflict for a single 'from', or null if there isn't one
    this.conflict = async (from) => {
      const results = await conflicts(this.blog, [{ from, to: "/anywhere" }]);
      return results[0];
    };

    this.publish = async (path, content) => {
      await fs.outputFile(this.blogDirectory + path, content);
      const entry = await promisify(build)(this.blog, path);
      await promisify(Entry.set)(this.blog.id, path, entry);
      return entry;
    };

    this.write = async (path, content) =>
      await fs.outputFile(this.blogDirectory + path, content);

    this.useTemplate = async (views) => {
      const { id } = await promisify(Template.create)(
        this.blog.id,
        "conflicts",
        {}
      );

      for (const view of views)
        await promisify(Template.setView)(id, {
          ...view,
          content: view.content || "Hello",
        });

      this.blog.template = id;
    };
  });

  it("does not warn about a redirect from an unused path", async function () {
    expect(await this.conflict("/nothing-here")).toEqual(null);
  });

  it("warns about a redirect from the URL of a post", async function () {
    await this.publish(
      "/hello.md",
      ["---", "Permalink: /hello", "---", "", "# Hello"].join("\n")
    );

    const conflict = await this.conflict("/hello");

    expect(conflict.type).toEqual("post");
    expect(conflict.message).toContain("a post on your site");
    expect(conflict.message).toContain("/hello");
  });

  it("warns about a redirect from the URL of a page", async function () {
    await this.publish(
      "/about.md",
      ["---", "Page: yes", "Permalink: /about", "---", "", "# About"].join("\n")
    );

    expect((await this.conflict("/about")).type).toEqual("page");
  });

  it("ignores the case and trailing slash of a redirect", async function () {
    await this.publish(
      "/hello.md",
      ["---", "Permalink: /hello", "---", "", "# Hello"].join("\n")
    );

    expect((await this.conflict("/Hello/")).type).toEqual("post");
  });

  it("does not warn about a redirect from the URL of a draft", async function () {
    await this.publish(
      "/secret.md",
      ["---", "Draft: yes", "Permalink: /secret", "---", "", "# Secret"].join(
        "\n"
      )
    );

    expect(await this.conflict("/secret")).toEqual(null);
  });

  it("warns about a redirect from a URL rendered by a template view", async function () {
    await this.useTemplate([{ name: "topics.html", url: ["/topics/:topic"] }]);

    const conflict = await this.conflict("/topics/apples");

    expect(conflict.type).toEqual("view");
    expect(conflict.message).toContain("topics.html");
  });

  it("warns about a redirect from a URL Blot handles itself", async function () {
    for (const from of [
      "/",
      "/search",
      "/random",
      "/page/2",
      "/tagged/apples",
      "/tagged/apples/page/2",
    ]) {
      expect((await this.conflict(from)).type).toEqual("route");
    }
  });

  it("does not warn about a redirect from a URL Blot falls through", async function () {
    // The default template ships its own robots.txt view, which would
    // otherwise catch this redirect first and mask what we're testing here.
    await this.useTemplate([]);

    for (const from of ["/robots.txt", "/draft/view/hello.md"])
      expect(await this.conflict(from)).toEqual(null);
  });

  it("warns about a redirect from the URL of a file in the folder", async function () {
    await this.write("/notes.pdf", "Not really a PDF");

    const conflict = await this.conflict("/notes.pdf");

    expect(conflict.type).toEqual("file");
    expect(conflict.message).toContain("/notes.pdf");
  });

  it("warns about a redirect from a URL served by an HTML file in the folder", async function () {
    await this.write("/guide/index.html", "<p>Guide</p>");

    expect((await this.conflict("/guide")).type).toEqual("file");
  });

  it("does not warn about a redirect from a path outside the folder", async function () {
    expect(await this.conflict("/../../etc/passwd")).toEqual(null);
  });

  it("does not try to resolve a regular expression redirect", async function () {
    await this.publish(
      "/hello.md",
      ["---", "Permalink: /hello", "---", "# Hello"].join("\n")
    );

    expect(await this.conflict("/(.*)")).toEqual(null);
    expect(await this.conflict("\\/hello")).toEqual(null);
  });

  it("does not try to resolve a redirect from another site", async function () {
    expect(await this.conflict("https://example.com/")).toEqual(null);
  });

  it("returns a result for every redirect", async function () {
    await this.publish(
      "/hello.md",
      ["---", "Permalink: /hello", "---", "# Hello"].join("\n")
    );

    const results = await conflicts(this.blog, [
      { from: "/nothing-here", to: "/anywhere" },
      { from: "/hello", to: "/anywhere" },
      { from: "/search", to: "/anywhere" },
    ]);

    expect(results.length).toEqual(3);
    expect(results[0]).toEqual(null);
    expect(results[1].type).toEqual("post");
    expect(results[2].type).toEqual("route");
  });

  it("returns nothing when there are no redirects", async function () {
    expect(await conflicts(this.blog, [])).toEqual([]);
  });
});
