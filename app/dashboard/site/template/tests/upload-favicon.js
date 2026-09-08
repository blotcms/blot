describe("upload favicon", function () {
  global.test.blog();
  global.test.tmp();

  const fs = require("fs-extra");
  const { join } = require("path");
  const config = require("config");
  const sharp = require("sharp");
  const Template = require("models/template");
  const uploadFavicon = require("../save/upload-favicon");

  const assetDir = function (blog) {
    return join(config.blog_static_files_dir, blog.id, "_template_assets");
  };

  beforeEach(function (done) {
    const test = this;
    Template.create(test.blog.id, "Favicon Test", {}, function (err) {
      if (err) return done.fail(err);
      Template.getTemplateList(test.blog.id, function (err, templates) {
        if (err) return done.fail(err);
        test.template = templates.find((t) => t.name === "Favicon Test");
        done();
      });
    });
  });

  const makeReq = async function (test, body, { withFile } = {}) {
    const req = {
      blog: test.blog,
      params: { templateSlug: test.template.slug },
      template: test.template,
      files: {},
      body: body || {},
      query: { ajax: "1" },
    };
    if (withFile) {
      const source = join(test.tmp, `src-${Date.now()}-${Math.random()}.png`);
      await sharp({ create: { width: withFile.width || 200, height: withFile.height || 100, channels: 4, background: "#2244ff" } })
        .png()
        .toFile(source);
      req.files = { favicon: [{ path: source, size: (await fs.stat(source)).size }] };
    }
    return req;
  };

  const run = async function (req) {
    const result = {};
    const res = {
      json: (body) => { result.body = body; },
      message: (redirect, message) => { result.redirect = redirect; result.message = message; },
    };
    const next = jasmine.createSpy("next");
    await uploadFavicon(req, res, next);
    return { result, next };
  };

  it("stores generated favicon URLs in the template locals", async function () {
    const req = await makeReq(this, { crop_x: "0.25", crop_y: "0", crop_size: "1" }, { withFile: {} });

    const { result, next } = await run(req);

    expect(next).not.toHaveBeenCalled();
    expect(result.body.favicon.ico).toMatch(/\.ico$/);
    expect(result.body.favicon.png16).toMatch(/-16\.png$/);
    expect(result.body.favicon.png32).toMatch(/-32\.png$/);
    expect(result.body.favicon.appleTouch).toMatch(/-180\.png$/);

    // Persisted, and the generated files are on disk.
    const templates = await new Promise((resolve, reject) =>
      Template.getTemplateList(this.blog.id, (err, list) => (err ? reject(err) : resolve(list)))
    );
    const saved = templates.find((t) => t.id === this.template.id);
    expect(saved.locals.favicon.prefix).toEqual(result.body.favicon.prefix);
    expect(await fs.pathExists(join(assetDir(this.blog), `${result.body.favicon.prefix}.ico`))).toBe(true);
  });

  it("falls back to a centered crop when the crop fields are blank", async function () {
    const req = await makeReq(this, { crop_x: "", crop_y: "", crop_size: "" }, { withFile: { width: 200, height: 100 } });

    const { result, next } = await run(req);

    expect(next).not.toHaveBeenCalled();
    expect(result.body.favicon.prefix).toMatch(/^favicon-/);
  });

  it("keeps the existing favicon when 'Save changes' is clicked without a file", async function () {
    const first = await run(await makeReq(this, { crop_x: "", crop_y: "", crop_size: "" }, { withFile: {} }));
    const favicon = first.result.body.favicon;

    const { result, next } = await run(await makeReq(this, {}));

    expect(next).not.toHaveBeenCalled();
    expect(result.body).toEqual({ favicon });
    expect(await fs.pathExists(join(assetDir(this.blog), `${favicon.prefix}.ico`))).toBe(true);
  });

  it("removes the favicon and its assets only when the delete button is used", async function () {
    const first = await run(await makeReq(this, { crop_x: "", crop_y: "", crop_size: "" }, { withFile: {} }));
    const favicon = first.result.body.favicon;

    const { result, next } = await run(await makeReq(this, { remove: "1" }));

    expect(next).not.toHaveBeenCalled();
    expect(result.body).toEqual({ favicon: null });
    expect(await fs.pathExists(join(assetDir(this.blog), `${favicon.prefix}.ico`))).toBe(false);

    const templates = await new Promise((resolve, reject) =>
      Template.getTemplateList(this.blog.id, (err, list) => (err ? reject(err) : resolve(list)))
    );
    expect(templates.find((t) => t.id === this.template.id).locals.favicon).toBeUndefined();
  });
});
