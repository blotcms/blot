describe("getFullView folder links", function () {
  require("./setup")({ createTemplate: true });

  const { promisify } = require("util");
  const config = require("config");
  const Template = require("../index");

  const getView = promisify(Template.getView);
  const getFullView = promisify(Template.getFullView);
  const createTemplate = promisify(Template.create);
  const dropTemplate = promisify(Template.drop);
  const setView = promisify(Template.setView);

  const wrap = (path) => `{{#cdn}}${path}{{/cdn}}`;

  // getFullView's response: [locals, partials, retrieve, type, source, usesBacklinks]
  const PARTIALS = 1;
  const RETRIEVE = 2;
  const SOURCE = 4;

  it("renders the blog's own template with its folder links wrapped", async function () {
    await this.setView({ name: "index.html", content: '<img src="/a.png">' });

    const response = await getFullView(this.blog.id, this.template.id, "index.html");

    expect(response[SOURCE]).toBe(`<img src="${wrap("/a.png")}">`);
  });

  it("merges the wrapped targets into retrieve.cdn, so the helper is loaded", async function () {
    await this.setView({
      name: "index.html",
      content: '<img src="/a.png"><link href="{{#cdn}}/style.css{{/cdn}}">',
    });

    const response = await getFullView(this.blog.id, this.template.id, "index.html");

    expect(response[RETRIEVE].cdn.slice().sort()).toEqual(["a.png", "style.css"]);
  });

  it("leaves the stored view as the author wrote it", async function () {
    await this.setView({ name: "index.html", content: '<img src="/a.png">' });
    await getFullView(this.blog.id, this.template.id, "index.html");

    const view = await getView(this.template.id, "index.html");

    expect(view.content).toBe('<img src="/a.png">');
    expect(view.resolvedContent).toBeUndefined();
    expect(view.retrieve.cdn).toBeUndefined();
  });

  it("strips the blog's current hosts", async function () {
    await this.setView({
      name: "index.html",
      content: `<img src="https://${this.blog.handle}.${config.host}/a.png">`,
    });

    const response = await getFullView(this.blog.id, this.template.id, "index.html");

    expect(response[SOURCE]).toBe(`<img src="${wrap("/a.png")}">`);
  });

  it("renders the author's content for any other blog", async function () {
    await this.setView({ name: "index.html", content: '<img src="/a.png">' });

    const response = await getFullView("blog_somebodyelse", this.template.id, "index.html");

    expect(response[SOURCE]).toBe('<img src="/a.png">');
    expect(response[RETRIEVE].cdn).toBeUndefined();
  });

  it("never wraps a SITE template", async function () {
    const name = "site-folder-links";
    const id = (await createTemplate("SITE", name, {})).id;

    try {
      await setView(id, { name: "index.html", content: '<img src="/a.png">' });

      const response = await getFullView(this.blog.id, id, "index.html");

      expect(response[SOURCE]).toBe('<img src="/a.png">');
    } finally {
      await dropTemplate("SITE", name);
    }
  });

  it("leaves a view that changes delimiters untouched", async function () {
    const content = '{{=<% %>=}}<img src="/a.png">';

    await this.setView({ name: "index.html", content });

    const response = await getFullView(this.blog.id, this.template.id, "index.html");

    expect(response[SOURCE]).toBe(content);
    expect(response[RETRIEVE].cdn).toBeUndefined();
  });

  it("wraps CSS views", async function () {
    await this.setView({ name: "style.css", content: "a{background:url(img/a.png)}" });

    const response = await getFullView(this.blog.id, this.template.id, "style.css");

    expect(response[SOURCE]).toBe(`a{background:url(${wrap("img/a.png")})}`);
  });

  describe("partials", function () {
    it("wraps partials fetched as views", async function () {
      await this.setView({ name: "header.html", content: '<img src="/logo.png">' });
      await this.setView({ name: "index.html", content: "{{> header.html}}" });

      const owner = await getFullView(this.blog.id, this.template.id, "index.html");
      const other = await getFullView("blog_somebodyelse", this.template.id, "index.html");

      expect(owner[PARTIALS]["header.html"]).toBe(`<img src="${wrap("/logo.png")}">`);
      expect(other[PARTIALS]["header.html"]).toBe('<img src="/logo.png">');
    });

    it("loads the {{#cdn}} helper for a view whose partial has folder links", async function () {
      await this.setView({ name: "header.html", content: '<img src="/logo.png">' });
      await this.setView({ name: "index.html", content: "{{#entries}}{{> header.html}}{{/entries}}" });

      const response = await getFullView(this.blog.id, this.template.id, "index.html");

      expect(response[RETRIEVE].cdn).toEqual(["logo.png"]);
    });

    it("wraps nested partials", async function () {
      await this.setView({ name: "logo.html", content: '<img src="/logo.png">' });
      await this.setView({ name: "header.html", content: "<header>{{> logo.html}}</header>" });
      await this.setView({ name: "index.html", content: "{{> header.html}}" });

      const response = await getFullView(this.blog.id, this.template.id, "index.html");

      expect(response[PARTIALS]["logo.html"]).toBe(`<img src="${wrap("/logo.png")}">`);
      expect(response[RETRIEVE].cdn).toEqual(["logo.png"]);
    });

    it("wraps inline package.json partials", async function () {
      await this.setView({
        name: "index.html",
        content: "{{> inline}}",
        partials: { inline: '<img src="/inline.png">' },
      });

      const response = await getFullView(this.blog.id, this.template.id, "index.html");

      expect(response[PARTIALS].inline).toBe(`<img src="${wrap("/inline.png")}">`);
      expect(response[RETRIEVE].cdn).toEqual(["inline.png"]);
    });

    it("wraps inline partials with the blog's hosts", async function () {
      await this.setView({
        name: "index.html",
        content: "{{> inline}}",
        partials: {
          inline: `<img src="https://${this.blog.handle}.${config.host}/inline.png">`,
        },
      });

      const response = await getFullView(this.blog.id, this.template.id, "index.html");

      expect(response[PARTIALS].inline).toBe(`<img src="${wrap("/inline.png")}">`);
    });

    it("leaves inline partials as they are for any other blog", async function () {
      await this.setView({
        name: "index.html",
        content: "{{> inline}}",
        partials: { inline: '<img src="/inline.png">' },
      });

      const response = await getFullView("blog_somebodyelse", this.template.id, "index.html");

      expect(response[PARTIALS].inline).toBe('<img src="/inline.png">');
      expect(response[RETRIEVE].cdn).toBeUndefined();
    });
  });
});
