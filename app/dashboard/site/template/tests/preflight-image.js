describe("template image upload preflight", function () {
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
    for (const request of [
      { files: { image: [{ size: 1 }] }, body: {} },
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
});
