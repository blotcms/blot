describe("template README", function () {
  require("./setup")({ createTemplate: true });

  const Template = require("../index");
  const isReadme = require("../util/isReadme");
  const client = require("models/client");
  const key = require("../key");

  it("recognises README, readme.txt and README.md in any case", function () {
    ["README", "readme", "Readme.txt", "README.md", "readme.MD"].forEach(
      (name) => expect(isReadme(name)).toBe(true)
    );

    ["README.html", "readme.css", "about.md", "my-readme", undefined].forEach(
      (name) => expect(isReadme(name)).toBe(false)
    );
  });

  it("stores a README as written, with no URL, even when it isn't valid Mustache", async function () {
    const content = "Use {{#entry}} for the entry and {{> head}} for the head";

    await this.setView({ name: "README.md", url: "/README.md", content });

    const view = await Template.getView(this.template.id, "README.md");
    expect(view.content).toEqual(content);
    expect(view.url).toBeUndefined();
    expect(view.partials).toEqual({});

    const { views } = await Template.getAllViews(this.template.id);
    expect(Object.keys(views)).toContain("README.md");

    expect((await this.getViewByURL("/README.md")).viewName).toBe(null);
  });

  it("is never routed, even with a URL stored before READMEs stopped being pages", async function () {
    const templateID = this.template.id;

    await this.setView({ name: "README", content: "Notes" });

    // As saved before this change: a pattern and an exact-URL key
    await client.hSet(key.view(templateID, "README"), "url", "/readme");
    await client.hSet(key.urlPatterns(templateID), "README", '["/readme"]');
    await client.set(key.url(templateID, "/readme"), "README");

    expect((await this.getViewByURL("/readme")).viewName).toBe(null);
    expect(await Template.getViewsByURLs(templateID, ["/readme"])).toEqual([
      null,
    ]);

    // Saving it again clears the old URL
    await this.setView({ name: "README", content: "Notes, edited" });

    expect(await client.hGet(key.urlPatterns(templateID), "README")).toBe(null);
    expect(await client.get(key.url(templateID, "/readme"))).toBe(null);
  });

  it("can't be rendered or used as a partial", async function () {
    await this.setView({ name: "readme.txt", content: "Notes" });
    await this.setView({
      name: "page.html",
      url: "/page",
      content: "Page{{> readme.txt}}",
    });

    expect(
      await Template.getFullView(this.blog.id, this.template.id, "readme.txt")
    ).toBe(null);

    const fullView = await Template.getFullView(
      this.blog.id,
      this.template.id,
      "page.html"
    );
    expect(fullView[1]["readme.txt"]).toEqual("");
  });

  it("still renders readme.html, found by its name without the extension", async function () {
    await this.setView({ name: "readme.html", content: "Readme page" });
    await this.setView({
      name: "page.html",
      url: "/page",
      content: "Page{{> readme}}",
    });

    const fullView = await Template.getFullView(
      this.blog.id,
      this.template.id,
      "page.html"
    );
    expect(fullView[1].readme).toEqual("Readme page");

    expect(
      await Template.getFullView(this.blog.id, this.template.id, "readme")
    ).not.toBe(null);
  });
});
