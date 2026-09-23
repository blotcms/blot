describe("template editor preview reload", function () {
  global.test.blog();

  const { promisify } = require("util");
  const Template = require("models/template");
  const previewReload = require("helper/publishPreviewReload");
  const settingsRouter = require("../index");
  const sourceRouter = require("../source-code");
  const getMetadata = promisify(Template.getMetadata);
  const createTemplate = promisify(Template.create);

  function postHandlers(router, path) {
    const layer = router.stack.find(function (entry) {
      return entry.route && entry.route.path === path;
    });

    if (!layer) throw new Error("No route " + path);

    const handlers = layer.route.stack
      .filter(function (entry) {
        return entry.method === "post";
      })
      .map(function (entry) {
        return entry.handle;
      });

    if (!handlers.length) throw new Error("No POST handlers for " + path);
    return handlers;
  }

  function runHandlers(handlers, req) {
    return new Promise(function (resolve) {
      let settled = false;
      const res = {
        locals: {},
        set: function () {
          return res;
        },
        status: function (code) {
          res.statusCode = code;
          return res;
        },
        end: function () {
          finish();
          return res;
        },
        send: function (body) {
          res.body = body;
          finish();
          return res;
        },
        message: function () {
          finish();
        },
      };

      function finish(err) {
        if (settled) return;
        settled = true;
        resolve({ err: err, res: res });
      }

      function step(index, err) {
        if (settled) return;
        if (err) return finish(err);
        if (index >= handlers.length) return finish();
        try {
          handlers[index](req, res, function (nextErr) {
            step(index + 1, nextErr);
          });
        } catch (error) {
          finish(error);
        }
      }

      step(0);
    });
  }

  beforeEach(async function () {
    this.template = await createTemplate(this.blog.id, "Example", {
      locals: { background_color: "#ffffff" },
    });
    spyOn(previewReload, "publish").and.callThrough();
  });

  it("reloads an open preview when background_color is saved", async function () {
    const handlers = postHandlers(settingsRouter, "/:templateSlug");
    const req = {
      blog: this.blog,
      template: this.template,
      params: { templateSlug: this.template.slug },
      body: { "locals.background_color": "#010203" },
      query: { ajax: "true" },
      baseUrl: "/sites/" + this.blog.handle + "/template",
    };

    const result = await runHandlers(handlers, req);

    expect(result.err).toBeUndefined();
    const metadata = await getMetadata(this.template.id);
    expect(metadata.locals.background_color).toBe("#010203");
    expect(previewReload.publish).toHaveBeenCalledWith(this.blog.id);
  });

  it("reloads an open preview when package.json locals are saved", async function () {
    const handlers = postHandlers(sourceRouter, "/:viewSlug/edit");
    const req = {
      blog: this.blog,
      template: this.template,
      view: { name: "package.json" },
      params: { viewSlug: "package.json" },
      body: {
        content: JSON.stringify({
          locals: { background_color: "#abcdef" },
        }),
      },
      baseUrl: "/sites/" + this.blog.handle + "/template/example/source-code",
    };
    req.template.owner = this.blog.id;

    const result = await runHandlers(handlers, req);

    expect(result.err).toBeUndefined();
    expect(result.res.body).toBe("Saved changes!");
    const metadata = await getMetadata(this.template.id);
    expect(metadata.locals.background_color).toBe("#abcdef");
    expect(previewReload.publish).toHaveBeenCalledWith(this.blog.id);
  });

  it("does not reload the preview when package.json is invalid", async function () {
    const handlers = postHandlers(sourceRouter, "/:viewSlug/edit");
    const req = {
      blog: this.blog,
      template: this.template,
      view: { name: "package.json" },
      params: { viewSlug: "package.json" },
      body: { content: "{not json" },
      baseUrl: "/sites/" + this.blog.handle + "/template/example/source-code",
    };

    const result = await runHandlers(handlers, req);

    expect(result.res.statusCode).toBe(500);
    expect(previewReload.publish).not.toHaveBeenCalled();
  });
});
