describe("upload template image", function () {
  global.test.blog();
  global.test.tmp();

  const fs = require("fs-extra");
  const { join } = require("path");
  const storage = require("storage/assets");
  const sharp = require("sharp");
  const Template = require("models/template");
  const uploadImage = require("../save/upload-image");

  const ASSETS = "_template_assets";
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
    const oldPath = ASSETS + "/" + decodeURIComponent(new URL(original.url).pathname.split("/").pop());

    await run(this, "hero_image", {}, await makeFile(this.tmp, "replacement.png"));
    expect(await storage.exists(this.blog.id, oldPath)).toBe(true);

    await run(this, "footer_image", { remove: "1" });
    expect(await storage.exists(this.blog.id, oldPath)).toBe(false);
  });

  it("retains old files when template references cannot be listed", async function () {
    const original = (await run(this, "hero_image", {}, await makeFile(this.tmp, "lookup.png"))).image;
    const oldPath = ASSETS + "/" + decodeURIComponent(new URL(original.url).pathname.split("/").pop());
    let sibling;
    await new Promise((resolve, reject) => Template.create(
      this.blog.id,
      "Sibling image reference",
      { locals: { shared_image: original } },
      (error, template) => {
        if (error) return reject(error);
        sibling = template;
        resolve();
      }
    ));
    const getMetadata = Template.getMetadata;
    spyOn(Template, "getMetadata").and.callFake((id, callback) => {
      if (id === sibling.id) return callback(new Error("metadata read failed"));
      return getMetadata(id, callback);
    });

    await uploadImage.removeAssetsIfUnreferenced({ blog: this.blog, template: this.template }, original);

    expect(await storage.exists(this.blog.id, oldPath)).toBe(true);
  });

  it("removes generated assets after their local template is dropped", async function () {
    const original = (await run(this, "hero_image", {}, await makeFile(this.tmp, "delete-template.png"))).image;
    const oldPath = ASSETS + "/" + decodeURIComponent(new URL(original.url).pathname.split("/").pop());
    const imageLocals = Object.values(this.template.locals)
      .filter((value) => value && value.url)
      .map((value) => ({ ...value, thumbnails: { ...value.thumbnails } }));

    await new Promise((resolve, reject) => Template.drop(
      this.blog.id,
      this.template.slug,
      (error) => error ? reject(error) : resolve()
    ));
    await uploadImage.removeTemplateAssetsIfUnreferenced({ blog: this.blog }, imageLocals);

    expect(await storage.exists(this.blog.id, oldPath)).toBe(false);
  });

  it("rolls back late metadata failures before removing generated files", async function () {
    const file = await makeFile(this.tmp, "persistence-failure.png");
    const realUpdate = Template.update;
    let calls = 0;
    spyOn(Template, "update").and.callFake((id, slug, updates, callback) => {
      calls += 1;
      if (calls === 1) {
        return realUpdate(id, slug, updates, (error) => callback(error || new Error("manifest unavailable")));
      }
      return realUpdate(id, slug, updates, callback);
    });
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

    expect(next).toHaveBeenCalledWith(jasmine.objectContaining({ message: "manifest unavailable" }));
    expect(calls).toBe(2);
    const saved = (await list(this.blog)).find((template) => template.id === this.template.id);
    expect(saved.locals.hero_image).toEqual({});
    const assets = await storage.list(this.blog.id, ASSETS);
    expect(assets.filter((name) => name.startsWith("image-")).length).toBe(0);
  });

  it("retains generated files if metadata rollback cannot be confirmed", async function () {
    const file = await makeFile(this.tmp, "rollback-failure.png");
    const realUpdate = Template.update;
    let calls = 0;
    spyOn(Template, "update").and.callFake((id, slug, updates, callback) => {
      calls += 1;
      if (calls === 1) {
        return realUpdate(id, slug, updates, (error) => callback(error || new Error("manifest unavailable")));
      }
      callback(new Error("rollback unavailable"));
    });
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

    expect(next).toHaveBeenCalledWith(jasmine.objectContaining({ message: "manifest unavailable" }));
    expect(calls).toBe(2);
    const saved = (await list(this.blog)).find((template) => template.id === this.template.id);
    expect(saved.locals.hero_image.url).toMatch(/image-[a-f0-9-]+-original\.webp$/);
    const assets = await storage.list(this.blog.id, ASSETS);
    expect(assets.filter((name) => name.startsWith("image-")).length).toBe(5);
  });

  it("restores metadata and removes the new assets when folder synchronization fails", async function () {
    const file = await makeFile(this.tmp, "folder-sync-failure.png");
    let calls = 0;
    spyOn(uploadImage.operations, "sync").and.callFake(() => {
      calls += 1;
      return calls === 1 ? Promise.reject(new Error("folder sync failed")) : Promise.resolve();
    });
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

    expect(next).toHaveBeenCalledWith(jasmine.objectContaining({ message: "folder sync failed" }));
    expect(calls).toBe(2);
    const saved = (await list(this.blog)).find((template) => template.id === this.template.id);
    expect(saved.locals.hero_image).toEqual({});
    const assets = await storage.list(this.blog.id, ASSETS);
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

  describe("profile photo shapes", function () {
    const assetName = (image) => ASSETS + "/" + decodeURIComponent(new URL(image.url).pathname.split("/").pop());
    const cornerAlpha = async (blog, image) => {
      const { data, info } = await sharp(await storage.read(blog.id, assetName(image))).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      return data[3 + 0 * info.channels];
    };

    beforeEach(async function () {
      this.template.locals.profile_image = {};
      await update(this.blog, this.template.slug, this.template.locals);
    });

    it("masks the square thumbnail and stores the shape", async function () {
      const { image } = await run(this, "profile_image", { photo_shape: "circle" }, await makeFile(this.tmp, "me.png", 200, 200));

      expect(image.mask).toBe("circle");
      expect(await cornerAlpha(this.blog, image.thumbnails.square)).toBe(0);
      expect(await storage.exists(this.blog.id, assetName(image.thumbnails.small))).toBe(true);
    });

    it("re-renders only the square when the shape changes without a new upload", async function () {
      const { image } = await run(this, "profile_image", { photo_shape: "square" }, await makeFile(this.tmp, "me.png", 200, 200));
      expect(await cornerAlpha(this.blog, image.thumbnails.square)).toBe(255);

      const changed = (await run(this, "profile_image", { update_mask: "1", photo_shape: "hexagon" })).image;

      expect(changed.mask).toBe("hexagon");
      expect(changed.url).toBe(image.url);
      expect(changed.thumbnails.small).toEqual(image.thumbnails.small);
      expect(changed.thumbnails.square.url).not.toBe(image.thumbnails.square.url);
      expect(await cornerAlpha(this.blog, changed.thumbnails.square)).toBe(0);
      expect(await storage.exists(this.blog.id, assetName(image.thumbnails.square))).toBe(false);
      expect(await storage.exists(this.blog.id, assetName(changed))).toBe(true);
    });

    it("starts from the stored square for photos saved before shapes existed", async function () {
      const { image } = await run(this, "profile_image", {}, await makeFile(this.tmp, "me.png", 200, 200));
      delete this.template.locals.profile_image.mask;
      await update(this.blog, this.template.slug, this.template.locals);
      const read = spyOn(storage, "read").and.callThrough();

      await run(this, "profile_image", { update_mask: "1", photo_shape: "circle" });

      expect(read).toHaveBeenCalledTimes(1);
      expect(read.calls.argsFor(0)[1]).toBe(assetName(image.thumbnails.square));
    });

    it("keeps the new square when the metadata rollback cannot be confirmed", async function () {
      const { image } = await run(this, "profile_image", { photo_shape: "square" }, await makeFile(this.tmp, "me.png", 200, 200));
      const realUpdate = Template.update;
      let calls = 0;
      spyOn(Template, "update").and.callFake((id, slug, updates, callback) => {
        calls += 1;
        if (calls === 1) return realUpdate(id, slug, updates, (error) => callback(error || new Error("manifest unavailable")));
        callback(new Error("rollback unavailable"));
      });
      const req = {
        blog: this.blog, template: this.template,
        params: { templateSlug: this.template.slug, key: "profile_image" },
        files: {}, body: { update_mask: "1", photo_shape: "circle" }, query: { ajax: "1" },
      };
      const next = jasmine.createSpy("next");

      await uploadImage(req, { locals: { images: [{ key: "profile_image" }] } }, next);

      expect(next).toHaveBeenCalledWith(jasmine.objectContaining({ message: "manifest unavailable", rollbackConfirmed: false }));
      const names = (await storage.list(this.blog.id, ASSETS)).filter((name) => name.endsWith("-square.webp"));
      expect(names.length).toBe(2);
      expect(names).toContain(assetName(image.thumbnails.square).split("/").pop());
    });

    it("leaves everything alone when the shape is unchanged", async function () {
      const { image } = await run(this, "profile_image", { photo_shape: "circle" }, await makeFile(this.tmp, "me.png", 200, 200));
      expect((await run(this, "profile_image", { update_mask: "1", photo_shape: "circle" })).image).toEqual(image);
    });
  });
});
