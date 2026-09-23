describe("upload template image", function () {
  global.test.blog();
  global.test.tmp();

  const fs = require("fs-extra");
  const { join } = require("path");
  const config = require("config");
  const sharp = require("sharp");
  const Template = require("models/template");
  const uploadImage = require("../save/upload-image");

  const assetDir = (blog) => join(config.blog_static_files_dir, blog.id, "_template_assets");
  const update = (blog, slug, locals) => new Promise((resolve, reject) =>
    Template.update(blog.id, slug, { locals }, (error) => error ? reject(error) : resolve())
  );
  const list = (blog) => new Promise((resolve, reject) =>
    Template.getTemplateList(blog.id, (error, templates) => error ? reject(error) : resolve(templates))
  );

  beforeEach(function (done) {
    const test = this;
    Template.create(test.blog.id, "Image Test", {
      locals: { hero_image: {}, footer_image: {} },
    }, function (error, template) {
      if (error) return done.fail(error);
      test.template = template;
      done();
    });
  });

  async function makeFile(directory, name, width = 240, height = 120) {
    const path = join(directory, name);
    await sharp({ create: { width, height, channels: 4, background: "#13579b" } })
      .png().toFile(path);
    return { path, size: (await fs.stat(path)).size };
  }

  async function run(test, key, body, file) {
    const result = {};
    const req = {
      blog: test.blog,
      template: test.template,
      params: { templateSlug: test.template.slug, key },
      files: file ? { image: [file] } : {},
      body: body || {},
      query: { ajax: "1" },
    };
    const res = {
      locals: {
        base: "/settings",
        images: Object.keys(test.template.locals)
          .filter((local) => local.endsWith("_image"))
          .map((local) => ({ key: local })),
      },
      json(value) { result.body = value; },
      message(redirect, message) { result.redirect = redirect; result.message = message; },
    };
    const next = jasmine.createSpy("next");
    await uploadImage(req, res, next);
    expect(next).not.toHaveBeenCalled();
    return result.body;
  }

  it("uploads derivatives and persists their dimensions", async function () {
    const image = (await run(this, "hero_image", {}, await makeFile(this.tmp, "hero.png"))).image;

    expect(image.width).toBe(240);
    expect(image.height).toBe(120);
    expect(image.thumbnails.small.width).toBe(160);
    expect(image.thumbnails.square.width).toBe(160);
    expect(image.thumbnails.square.height).toBe(160);

    const saved = (await list(this.blog)).find((template) => template.id === this.template.id);
    expect(saved.locals.hero_image).toEqual(image);
  });

  it("retains files referenced by a sibling local until its final reference is removed", async function () {
    const original = (await run(this, "hero_image", {}, await makeFile(this.tmp, "shared.png"))).image;
    this.template.locals.footer_image = original;
    await update(this.blog, this.template.slug, this.template.locals);
    const oldPath = join(assetDir(this.blog), decodeURIComponent(new URL(original.url).pathname.split("/").pop()));

    await run(this, "hero_image", {}, await makeFile(this.tmp, "replacement.png"));
    expect(await fs.pathExists(oldPath)).toBe(true);

    await run(this, "footer_image", { remove: "1" });
    expect(await fs.pathExists(oldPath)).toBe(false);
  });

  it("retains old files when template references cannot be listed", async function () {
    const original = (await run(this, "hero_image", {}, await makeFile(this.tmp, "lookup.png"))).image;
    const oldPath = join(assetDir(this.blog), decodeURIComponent(new URL(original.url).pathname.split("/").pop()));
    spyOn(Template, "getTemplateList").and.callFake((id, callback) => callback(new Error("redis unavailable")));

    await uploadImage.removeAssetsIfUnreferenced({ blog: this.blog, template: this.template }, original);

    expect(await fs.pathExists(oldPath)).toBe(true);
  });

  it("removes freshly generated files when metadata persistence fails", async function () {
    const file = await makeFile(this.tmp, "persistence-failure.png");
    spyOn(Template, "update").and.callFake((id, slug, updates, callback) => callback(new Error("redis unavailable")));
    const req = {
      blog: this.blog,
      template: this.template,
      params: { templateSlug: this.template.slug, key: "hero_image" },
      files: { image: [file] },
      body: {},
      query: { ajax: "1" },
    };
    const res = { locals: { images: [{ key: "hero_image" }] } };
    const next = jasmine.createSpy("next");

    await uploadImage(req, res, next);

    expect(next).toHaveBeenCalledWith(jasmine.objectContaining({ message: "redis unavailable" }));
    const assets = await fs.readdir(assetDir(this.blog)).catch(() => []);
    expect(assets.filter((name) => name.startsWith("image-")).length).toBe(0);
  });

  it("keeps the existing value when no file is submitted and rejects undeclared keys", async function () {
    const original = (await run(this, "hero_image", {}, await makeFile(this.tmp, "unchanged.png"))).image;
    expect((await run(this, "hero_image", {})).image).toEqual(original);

    const req = { files: {}, params: { key: "unknown_image" }, body: {}, blog: this.blog };
    const res = { locals: { images: [] } };
    const next = jasmine.createSpy("next");
    await uploadImage(req, res, next);
    expect(next).toHaveBeenCalledWith(jasmine.objectContaining({ status: 404 }));
  });
});
