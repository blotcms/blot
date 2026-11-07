describe("template", function () {
  require("./setup")({ createTemplate: true });

  const setMetadata = require("../index").setMetadata;
  const getMetadata = require("../index").getMetadata;
  const { promisify } = require("util");
  const getBlog = (by) => require("models/blog").get(by);
  const setBlog = promisify(require("models/blog").set);

  it("returns a promise, and throws when given a callback", async function () {
    const direct = require("../index").setMetadata;

    expect(await direct(this.template.id, { description: "one" })).toBe(true);
    expect(
      await direct(this.template.id, { description: "one" })
    ).toBeUndefined();

    const template = this.template;
    // The callback form is gone: passing one throws instead of calling back.
    try {
      await direct(template.id, { description: "two" }, function () {});
      fail("should have thrown");
    } catch (err) {
      expect(err.message).toMatch(/no longer takes a callback/);
    }

    await expectAsync(direct(template.id, null)).toBeRejected();
  });

  it("sets a template's metadata", async function () {
    var updates = { description: "A test template description" };
    await setMetadata(this.template.id, updates);
    const template = await getMetadata(this.template.id);
    expect(template.description).toEqual(updates.description);
  });

  it("updates the cache ID of the blog which has the template installed after updating", async function () {
    await setBlog(this.blog.id, { template: this.template.id });
    var initialCacheID = (await getBlog({ id: this.blog.id })).cacheID;
    var updates = { description: "Updated template description" };
    await setMetadata(this.template.id, updates);
    const blog = await getBlog({ id: this.template.owner });
    expect(blog.cacheID).not.toEqual(initialCacheID);
  });

  it("leaves the owner blog's cache ID alone when the template is not installed", async function () {
    var initialCacheID = (await getBlog({ id: this.blog.id })).cacheID;
    await setMetadata(this.template.id, { description: "Not installed" });
    const blog = await getBlog({ id: this.template.owner });
    expect(blog.cacheID).toEqual(initialCacheID);
  });

  it("gives the template a new cache ID when its metadata changes", async function () {
    const before = (await getMetadata(this.template.id)).cacheID;
    await setMetadata(this.template.id, { description: "Changed" });
    const after = (await getMetadata(this.template.id)).cacheID;
    expect(after).toEqual(jasmine.any(String));
    expect(after).not.toEqual(before);

    await setMetadata(this.template.id, { description: "Changed" });
    expect((await getMetadata(this.template.id)).cacheID).toEqual(after);
  });

  it("compares object values by content, not identity", async function () {
    await setBlog(this.blog.id, { template: this.template.id });
    await setMetadata(this.template.id, { errors: {}, localEditing: true });

    const blogCacheID = (await getBlog({ id: this.blog.id })).cacheID;
    const templateCacheID = (await getMetadata(this.template.id)).cacheID;

    // a fresh but equal object, as readFromFolder passes on every sync
    await setMetadata(this.template.id, { errors: {}, localEditing: true });
    expect((await getBlog({ id: this.blog.id })).cacheID).toEqual(blogCacheID);
    expect((await getMetadata(this.template.id)).cacheID).toEqual(
      templateCacheID
    );

    await setMetadata(this.template.id, {
      errors: { "entries.html": "Unclosed tag" },
    });
    expect((await getBlog({ id: this.blog.id })).cacheID).not.toEqual(
      blogCacheID
    );
    expect((await getMetadata(this.template.id)).cacheID).not.toEqual(
      templateCacheID
    );
  });

  it("never writes a template cache ID it was given or had read", async function () {
    const client = require("models/client");
    const key = require("../key");
    await client.hSet(key.metadata(this.template.id), "cacheID", "newer");
    await setMetadata(this.template.id, { cacheID: "older" });
    expect((await getMetadata(this.template.id)).cacheID).not.toEqual("older");
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
    await this.blog.update({ template: this.template.id });

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
