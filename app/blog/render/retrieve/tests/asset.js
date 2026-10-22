const asset = require("../asset");

describe("asset", function () {
  function getLambda() {
    return new Promise((resolve, reject) => {
      asset({}, {}, (err, factory) => {
        if (err) return reject(err);
        resolve(factory());
      });
    });
  }

  it("adds a leading slash and a cache-busting query string for files with an extension", async function () {
    const lambda = await getLambda();
    const render = (text) => text.replace("{{cacheID}}", "123");

    expect(lambda("logo.png", render)).toEqual(
      "/logo.png?cache=123&amp;extension=.png"
    );
  });

  it("leaves an existing leading slash alone", async function () {
    const lambda = await getLambda();
    const render = (text) => text.replace("{{cacheID}}", "123");

    expect(lambda("/logo.png", render)).toEqual(
      "/logo.png?cache=123&amp;extension=.png"
    );
  });

  it("does not append a cache-busting query string for text without an extension", async function () {
    const lambda = await getLambda();
    const render = (text) => text;

    expect(lambda("logo", render)).toEqual("/logo");
  });

  describe("with a CDN manifest", function () {
    const BLOT_CDN_TOKEN = require("../../replaceFolderLinks/cdnToken");

    function getLambdaFor(req) {
      return new Promise((resolve, reject) => {
        asset(req, {}, (err, factory) => {
          if (err) return reject(err);
          resolve(factory());
        });
      });
    }

    const request = (cdn) => ({
      blog: { id: "blog_1" },
      template: { id: "blog_1:t", cdn },
    });

    it("returns the CDN URL of a file the manifest resolves", async function () {
      const lambda = await getLambdaFor(
        request({ "img/a.png": { path: "/img/a.png", version: "abc12345" } })
      );
      const render = (text) => text;

      expect(lambda("/img/a.png", render)).toEqual(
        BLOT_CDN_TOKEN + "/folder/v-abc12345/blog_1/img/a.png"
      );
      expect(lambda("img/a.png", render)).toEqual(
        BLOT_CDN_TOKEN + "/folder/v-abc12345/blog_1/img/a.png"
      );
    });

    it("keeps the cache-busted URL for a target the manifest doesn't resolve", async function () {
      const lambda = await getLambdaFor(request({}));
      const render = (text) => text.replace("{{cacheID}}", "123");

      expect(lambda("/img/a.png", render)).toEqual(
        "/img/a.png?cache=123&amp;extension=.png"
      );
    });

    it("keeps the cache-busted URL for a rendered view", async function () {
      const lambda = await getLambdaFor(request({ "style.css": "0123456789abcdef" }));
      const render = (text) => text.replace("{{cacheID}}", "123");

      expect(lambda("/style.css", render)).toEqual(
        "/style.css?cache=123&amp;extension=.css"
      );
    });

    it("keeps the cache-busted URL on a preview subdomain", async function () {
      const req = request({ "img/a.png": { path: "/img/a.png", version: "abc12345" } });
      req.preview = true;
      const lambda = await getLambdaFor(req);
      const render = (text) => text.replace("{{cacheID}}", "123");

      expect(lambda("/img/a.png", render)).toEqual(
        "/img/a.png?cache=123&amp;extension=.png"
      );
    });
  });
});
