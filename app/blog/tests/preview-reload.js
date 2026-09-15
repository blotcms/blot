describe("preview reload route", function () {
  const routePath = require.resolve("../routes/preview-reload");
  const ssePath = require.resolve("helper/sse");
  let originalSse;

  beforeEach(function () {
    originalSse = require.cache[ssePath];
  });

  afterEach(function () {
    delete require.cache[routePath];
    if (originalSse) require.cache[ssePath] = originalSse;
    else delete require.cache[ssePath];
  });

  it("only opens an SSE subscription on the preview subdomain", function () {
    const stream = jasmine.createSpy("stream");
    require.cache[ssePath] = {
      exports: function () { return stream; },
    };
    delete require.cache[routePath];
    const routes = {};
    require("../routes/preview-reload")({
      get: function (path, handler) { routes[path] = handler; },
    });
    const next = jasmine.createSpy("next");
    const response = {};

    routes["/__blot/preview/reload"]({ preview: false }, response, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(stream).not.toHaveBeenCalled();

    const previewRequest = { preview: true };
    routes["/__blot/preview/reload"](previewRequest, response, next);
    expect(stream).toHaveBeenCalledWith(previewRequest, response);
  });
});
