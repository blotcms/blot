describe("template image upload preflight", function () {
  global.test.blog();
  global.test.tmp();

  const fs = require("fs-extra");
  const { join } = require("path");
  const sharp = require("sharp");
  const preflight = require("../save/preflight-image");

  function response(images) {
    const result = {};
    result.res = {
      locals: { images, base: "/template/example" },
      json(value) { result.json = value; },
      message(redirect, message) { result.redirect = redirect; result.message = message; },
    };
    return result;
  }

  it("stops an empty upload before fork middleware runs", async function () {
    const old = { url: "https://cdn.example/image.webp" };
    const req = {
      template: { locals: { hero_image: old } },
      params: { key: "hero_image" },
      files: {},
      body: {},
      query: { ajax: "1" },
    };
    const result = response([{ key: "hero_image" }]);
    const next = jasmine.createSpy("next");

    await preflight(req, result.res, next);

    expect(next).not.toHaveBeenCalled();
    expect(result.json).toEqual({ image: old });
  });

  it("rejects an unknown key before fork middleware runs", async function () {
    const req = {
      template: { locals: {} },
      params: { key: "stale_image" },
      files: {},
      body: {},
      query: {},
    };
    const result = response([]);
    const next = jasmine.createSpy("next");

    await preflight(req, result.res, next);

    expect(next).toHaveBeenCalledWith(jasmine.objectContaining({ status: 404 }));
  });

  it("allows uploads and explicit removals to reach the fork middleware", async function () {
    const uploadPath = join(this.tmp, "valid-image.png");
    await sharp({ create: { width: 80, height: 60, channels: 3, background: "#123456" } })
      .png()
      .toFile(uploadPath);
    const upload = { path: uploadPath, size: (await fs.stat(uploadPath)).size };

    for (const request of [
      { files: { image: [upload] }, body: {} },
      { files: {}, body: { remove: "1" } },
    ]) {
      const req = {
        template: { locals: { hero_image: {} } },
        params: { key: "hero_image" },
        query: {},
        ...request,
      };
      const result = response([{ key: "hero_image" }]);
      const next = jasmine.createSpy("next");

      await preflight(req, result.res, next);

      expect(next).toHaveBeenCalledWith();
    }
  });

  it("rejects corrupt image data before the fork middleware and removes the upload", async function () {
    const path = join(this.tmp, "corrupt-image.png");
    await fs.writeFile(path, "not an image");
    const file = { path, size: 12 };
    const req = {
      template: { locals: { hero_image: {} } },
      params: { key: "hero_image" },
      files: { image: [file] },
      body: {},
      query: {},
    };
    const result = response([{ key: "hero_image" }]);
    const next = jasmine.createSpy("next");

    await preflight(req, result.res, next);

    expect(next).toHaveBeenCalledWith(jasmine.objectContaining({ status: 400 }));
    expect(await fs.pathExists(path)).toBe(false);
  });
});
