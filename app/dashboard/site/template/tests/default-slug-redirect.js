describe("/default template-editor shim", function () {
  const router = require("../index");

  // The shim is registered with TemplateEditor.use("/default", fn). Pick it
  // out of the router stack by the "default" fragment in its compiled path
  // regexp so we can exercise it in isolation, the way install.js does.
  const defaultShim = router.stack
    .filter(function (layer) {
      return !layer.route && layer.regexp && layer.regexp.source.includes("default");
    })
    .map(function (layer) {
      return layer.handle;
    })[0];

  it("is registered", function () {
    expect(typeof defaultShim).toEqual("function");
  });

  function run({ slug, base, path, originalUrl }) {
    return new Promise(function (resolve) {
      const req = { method: "GET", path: path, originalUrl: originalUrl };
      const res = {
        locals: { base: base },
        redirect: jasmine.createSpy("redirect"),
      };

      if (slug !== undefined) res.locals.template = { slug: slug };

      const next = jasmine.createSpy("next");

      Promise.resolve(defaultShim(req, res, next)).then(function () {
        resolve({
          redirect: res.redirect,
          next: next,
          redirectedTo: res.redirect.calls.any()
            ? res.redirect.calls.mostRecent().args.slice(-1)[0]
            : null,
        });
      });
    });
  }

  it("redirects /default to the installed template's slug", async function () {
    const { redirect, redirectedTo } = await run({
      slug: "cleanwhite",
      base: "/sites/example",
      path: "/",
      originalUrl: "/sites/example/template/default/",
    });

    expect(redirect).toHaveBeenCalled();
    expect(redirectedTo).toEqual("/sites/example/template/cleanwhite/");
  });

  it("preserves the sub-path when redirecting", async function () {
    const { redirectedTo } = await run({
      slug: "cleanwhite",
      base: "/sites/example",
      path: "/links",
      originalUrl: "/sites/example/template/default/links",
    });

    expect(redirectedTo).toEqual("/sites/example/template/cleanwhite/links");
  });

  it("falls through when there is no installed template slug", async function () {
    const { redirect, next } = await run({
      slug: undefined,
      base: "/sites/example",
      path: "/",
      originalUrl: "/sites/example/template/default/",
    });

    expect(redirect).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });

  // Regression: a local template whose own slug is literally "default"
  // (the user named it "default") made the shim redirect /template/default
  // to /template/default - the same URL - looping until the browser gave up
  // with ERR_TOO_MANY_REDIRECTS.
  it("does not redirect /default to itself when the installed slug is 'default'", async function () {
    const originalUrl = "/sites/example/template/default/";

    const { redirect, next, redirectedTo } = await run({
      slug: "default",
      base: "/sites/example",
      path: "/",
      originalUrl: originalUrl,
    });

    expect(redirectedTo).not.toEqual(originalUrl);
    expect(redirect).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });

  it("does not loop on a sub-path when the installed slug is 'default'", async function () {
    const originalUrl = "/sites/example/template/default/links";

    const { redirect, next, redirectedTo } = await run({
      slug: "default",
      base: "/sites/example",
      path: "/links",
      originalUrl: originalUrl,
    });

    expect(redirectedTo).not.toEqual(originalUrl);
    expect(redirect).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });
});
