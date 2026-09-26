const { promisify } = require("util");

describe("template", function () {
  require("./setup")({ createTemplate: true });

  const setMetadata = promisify(require("../index").setMetadata);
  const getMetadata = promisify(require("../index").getMetadata);
  const getBlog = promisify(require("models/blog").get);

  it("sets a template's metadata", async function () {
    var updates = { description: "A test template description" };
    await setMetadata(this.template.id, updates);
    const template = await getMetadata(this.template.id);
    expect(template.description).toEqual(updates.description);
  });

  it("updates the cache ID of the blog which owns a template after updating", async function () {
    var initialCacheID = this.blog.cacheID;
    var updates = { description: "Updated template description" };
    await setMetadata(this.template.id, updates);
    const blog = await getBlog({ id: this.template.owner });
    expect(blog.cacheID).not.toEqual(initialCacheID);
  });

  it("it will inject the font styles when you simply supply an id", async function () {
    var updates = { locals: { body_font: { id: "system-sans" } } };
    await setMetadata(this.template.id, updates);
    const { locals } = await getMetadata(this.template.id);
    const { body_font } = locals;
    expect(body_font.name).toEqual("System sans-serif");
    expect(body_font.stack).toContain("-apple-system");
    expect(body_font.styles).toEqual("");
    expect(body_font.line_height).toEqual(1.4);
    expect(body_font.font_size).toEqual(16);
    expect(body_font.line_width).toEqual(38);
  });

  it("it will inject the syntax highlighter styles when you simply supply an id", async function () {
    var updates = { locals: { syntax_highlighter: { id: "agate" } } };
    await setMetadata(this.template.id, updates);
    const { locals } = await getMetadata(this.template.id);
    const { syntax_highlighter } = locals;
    expect(syntax_highlighter.id).toEqual("agate");
    expect(syntax_highlighter.styles).toContain(".hljs{");
  });

  it("updates the CDN manifest when metadata locals change", async function () {
    // Install the template so the CDN manifest is generated
    await this.blog.update({template: this.template.id});

    await this.setView({
      name: "style.css",
      content: "body { color: {{background_color}}; }",
      locals: { background_color: "#fff" },
    });

    await this.setView({
      name: "index.html",
      content: "{{#cdn}}style.css{{/cdn}}",
    });

    const templateID = this.template.id;

    const initialMetadata = await getMetadata(templateID);
    const originalHash = initialMetadata.cdn["style.css"];
    expect(originalHash).toEqual(jasmine.any(String));

    await this.setView({
      name: "style.css",
      content: "body { color: {{background_color}}; }",
      locals: { background_color: "#000" },
    });

    const updatedMetadata = await getMetadata(templateID);
    const updatedHash = updatedMetadata.cdn["style.css"];
    expect(updatedHash).toEqual(jasmine.any(String));
    expect(updatedHash).not.toEqual(originalHash);

    await this.setView({
      name: "style.css",
      content: "body { color: {{background_color}}; }",
      locals: { background_color: "#123456" },
    });

    const nextMetadata = await getMetadata(templateID);
    expect(nextMetadata.cdn["style.css"]).toEqual(jasmine.any(String));
    expect(nextMetadata.cdn["style.css"]).not.toEqual(updatedHash);
  });

});
