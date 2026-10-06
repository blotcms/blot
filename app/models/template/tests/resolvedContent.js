describe("template resolved content", function () {
  require("./setup")({ createTemplate: true });

  const { promisify } = require("util");
  const config = require("config");
  const client = require("models/client");
  const Template = require("../index");
  const key = require("../key");

  const getView = promisify(Template.getView);
  const getFullView = promisify(Template.getFullView);
  const createTemplate = promisify(Template.create);
  const dropTemplate = promisify(Template.drop);

  const wrap = (path) => `{{#cdn}}${path}{{/cdn}}`;

  it("stores a copy of the view with its folder links wrapped in {{#cdn}}", async function () {
    await this.setView({ name: "index.html", content: '<img src="/a.png">' });

    const view = await getView(this.template.id, "index.html");

    expect(view.content).toBe('<img src="/a.png">');
    expect(view.resolvedContent).toBe(`<img src="${wrap("/a.png")}">`);
  });

  it("loads the {{#cdn}} helper for views with a resolved copy", async function () {
    await this.setView({ name: "index.html", content: '<img src="/a.png">' });

    const view = await getView(this.template.id, "index.html");

    // the wrapped file is not a retrieve target: it is found in the resolved
    // content when the manifest is built
    expect(view.retrieve.cdn).toEqual([]);
  });

  it("keeps explicit {{#cdn}} targets in retrieve.cdn", async function () {
    await this.setView({
      name: "index.html",
      content: '<img src="/a.png"><link href="{{#cdn}}/style.css{{/cdn}}">',
    });

    const view = await getView(this.template.id, "index.html");

    expect(view.retrieve.cdn).toEqual(["style.css"]);
  });

  it("stores nothing for views with no folder links", async function () {
    await this.setView({
      name: "index.html",
      content: '<p>{{title}}</p><a href="https://example.org/a.png">x</a>',
    });

    const view = await getView(this.template.id, "index.html");

    expect(view.resolvedContent).toBeUndefined();
    expect(view.retrieve.cdn).toBeUndefined();
  });

  it("removes the resolved copy when the links are edited out", async function () {
    await this.setView({ name: "index.html", content: '<img src="/a.png">' });
    await this.setView({ name: "index.html", content: "<p>no links</p>" });

    const view = await getView(this.template.id, "index.html");

    expect(view.content).toBe("<p>no links</p>");
    expect(view.resolvedContent).toBeUndefined();
    expect(await client.hExists(key.view(this.template.id, "index.html"), "resolvedContent")).toBe(false);
  });

  it("never accepts a resolved copy from the caller", async function () {
    await this.setView({
      name: "index.html",
      content: "<p>no links</p>",
      resolvedContent: "<p>evil</p>",
    });

    expect((await getView(this.template.id, "index.html")).resolvedContent).toBeUndefined();

    await this.setView({
      name: "index.html",
      content: '<img src="/a.png">',
      resolvedContent: "<p>evil</p>",
    });

    expect((await getView(this.template.id, "index.html")).resolvedContent).toBe(
      `<img src="${wrap("/a.png")}">`
    );
  });

  it("passes a stored view straight back in without keeping a stale copy", async function () {
    await this.setView({ name: "index.html", content: '<img src="/a.png">' });

    const stored = await getView(this.template.id, "index.html");

    stored.content = "<p>changed</p>";
    await this.setView(stored);

    expect((await getView(this.template.id, "index.html")).resolvedContent).toBeUndefined();
  });

  it("recomputes the copy of a view saved before resolved content existed", async function () {
    const viewKey = key.view(this.template.id, "index.html");

    await this.setView({ name: "index.html", content: '<img src="/a.png">' });
    await client.hDel(viewKey, "resolvedContent");

    // same content as stored: only a missing copy makes this a change
    await this.setView({ name: "index.html", content: '<img src="/a.png">' });

    expect((await getView(this.template.id, "index.html")).resolvedContent).toBe(
      `<img src="${wrap("/a.png")}">`
    );
  });

  it("replaces a copy that no longer matches the content", async function () {
    const viewKey = key.view(this.template.id, "index.html");

    await this.setView({ name: "index.html", content: '<img src="/a.png">' });
    await client.hSet(viewKey, "resolvedContent", "stale");
    await this.setView({ name: "index.html", content: '<img src="/a.png">' });

    expect((await getView(this.template.id, "index.html")).resolvedContent).toBe(
      `<img src="${wrap("/a.png")}">`
    );
  });

  it("leaves an up to date copy alone when the view is saved again", async function () {
    await this.setView({ name: "index.html", content: '<img src="/a.png">' });

    spyOn(console, "log").and.callThrough();

    await this.setView({ name: "index.html", content: '<img src="/a.png">' });

    expect(console.log.calls.allArgs().some((args) => args.includes("setView: short-circuit"))).toBe(true);
  });

  it("strips the blog's own hosts", async function () {
    await this.setView({
      name: "index.html",
      content: `<img src="https://${this.blog.handle}.${config.host}/a.png">`,
    });

    expect((await getView(this.template.id, "index.html")).resolvedContent).toBe(
      `<img src="${wrap("/a.png")}">`
    );
  });

  it("resolves a CSS view's relative links against its url", async function () {
    await this.setView({
      name: "style.css",
      url: "/css/style.css",
      content: "a{background:url(img/a.png)}",
    });

    expect((await getView(this.template.id, "style.css")).resolvedContent).toBe(
      `a{background:url(${wrap("/css/img/a.png")}{{!root-fallback:/img/a.png}})}`
    );

    // moving the view changes what its links point at
    await this.setView({
      name: "style.css",
      url: "/theme/style.css",
      content: "a{background:url(img/a.png)}",
    });

    expect((await getView(this.template.id, "style.css")).resolvedContent).toBe(
      `a{background:url(${wrap("/theme/img/a.png")}{{!root-fallback:/img/a.png}})}`
    );
  });

  it("does not resolve links for a SITE template", async function () {
    const name = "site-resolved-content";
    const id = (await createTemplate("SITE", name, {})).id;

    try {
      await promisify(Template.setView)(id, {
        name: "index.html",
        content: '<img src="/a.png">',
      });

      const view = await getView(id, "index.html");

      expect(view.content).toBe('<img src="/a.png">');
      expect(view.resolvedContent).toBeUndefined();
    } finally {
      await dropTemplate("SITE", name);
    }
  });

  it("copies a template with the links resolved for the new template", async function () {
    await this.setView({ name: "index.html", content: '<img src="/a.png">' });

    await createTemplate(this.blog.id, "copy", { cloneFrom: this.template.id });

    const copy = await getView(this.blog.id + ":copy", "index.html");

    expect(copy.content).toBe('<img src="/a.png">');
    expect(copy.resolvedContent).toBe(`<img src="${wrap("/a.png")}">`);
  });

  describe("rendering", function () {
    it("renders from the resolved copy for the blog that owns the template", async function () {
      await this.setView({ name: "index.html", content: '<img src="/a.png">' });

      const response = await getFullView(this.blog.id, this.template.id, "index.html");

      expect(response[4]).toBe(`<img src="${wrap("/a.png")}">`);
    });

    it("renders the author's content for any other blog", async function () {
      await this.setView({ name: "index.html", content: '<img src="/a.png">' });

      const response = await getFullView("blog_somebodyelse", this.template.id, "index.html");

      expect(response[4]).toBe('<img src="/a.png">');
    });

    it("renders partials from their resolved copies", async function () {
      await this.setView({ name: "header.html", content: '<img src="/logo.png">' });
      await this.setView({ name: "index.html", content: "{{> header.html}}" });

      const owner = await getFullView(this.blog.id, this.template.id, "index.html");
      const other = await getFullView("blog_somebodyelse", this.template.id, "index.html");

      expect(owner[1]["header.html"]).toBe(`<img src="${wrap("/logo.png")}">`);
      expect(other[1]["header.html"]).toBe('<img src="/logo.png">');
    });

    it("loads the {{#cdn}} helper for a view whose partial has folder links", async function () {
      await this.setView({ name: "header.html", content: '<img src="/logo.png">' });
      await this.setView({ name: "index.html", content: "{{> header.html}}" });

      const response = await getFullView(this.blog.id, this.template.id, "index.html");

      expect(response[2].cdn).toBeDefined();
    });
  });
});
