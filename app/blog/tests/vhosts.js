describe("blog server vhosts", function () {
  var vhosts = require("../vhosts");
  var config = require("config");

  it("extracts a blot domain", function (done) {
    var ctx = this;
    var host = this.blog.handle + "." + config.host;

    this.url("http://" + host);

    vhosts(this.req, this.res, function (err) {
      expect(err).not.toBeDefined();
      expect(ctx.req.originalHost).toEqual(host);
      expect(ctx.req.blog).toEqual(jasmine.any(Object));
      done();
    });
  });

  it("extracts a preview domain for one of Blot's template", function (done) {
    var ctx = this;
    var template = "default";
    var host =
      "preview." + template + "." + this.blog.handle + "." + config.host;

    this.url("http://" + host);

    vhosts(this.req, this.res, function (err) {
      expect(err).not.toBeDefined();
      expect(ctx.req.originalHost).toEqual(host);
      expect(ctx.req.preview).toEqual(true);
      expect(ctx.req.blog.template).toContain(template);
      expect(ctx.req.blog.template).not.toContain(ctx.blog.id);
      done();
    });
  });

  it("extracts a preview domain for one of the user's template", function (done) {
    var ctx = this;
    var template = "default";
    var host =
      "preview.my." + template + "." + this.blog.handle + "." + config.host;

    this.url("http://" + host);

    vhosts(this.req, this.res, function (err) {
      expect(err).not.toBeDefined();
      expect(ctx.req.originalHost).toEqual(host);
      expect(ctx.req.preview).toEqual(true);
      expect(ctx.req.blog.template).toContain(template);
      expect(ctx.req.blog.template).toContain(ctx.blog.id);
      done();
    });
  });

  it("works as expected", function () {
    expect(function () {
      var assert = require("assert");
      const {
        isSubdomain,
        extractHandle,
        extractPreviewTemplate,
      } = require("../vhosts");
      assert(isSubdomain("david." + config.host));
      assert(isSubdomain("a.b.c.d.e.f.g." + config.host));

      assert.equal(isSubdomain(config.host), false);
      assert.equal(isSubdomain("d.BLOG.im"), false);
      assert.equal(isSubdomain("google.com"), false);
      assert.equal(isSubdomain("...blot.im.."), false);
      assert.equal(isSubdomain("." + config.host), false);
      assert.equal(isSubdomain(""), false);

      assert.equal(extractHandle("david." + config.host), "david");
      assert.equal(
        extractHandle("preview.my.theme.david." + config.host),
        "david"
      );
      assert.equal(extractHandle("david.merfield." + config.host), "merfield");
      assert.equal(extractHandle("david.merfield.google.com"), "");

      assert.equal(extractPreviewTemplate("foo.david." + config.host), false);
      assert.equal(extractPreviewTemplate("david." + config.host), false);
      assert.equal(extractPreviewTemplate(config.host), false);
      assert.equal(extractPreviewTemplate(""), false);
      assert.equal(extractPreviewTemplate("google.com"), false);
      assert.equal(extractPreviewTemplate("preview." + config.host), false);
      assert.equal(
        extractPreviewTemplate("preview.david." + config.host),
        false
      );
      assert.equal(
        extractPreviewTemplate("preview.this.david.blot.com"),
        false
      );
      assert.equal(
        extractPreviewTemplate("this.preview.my.foo.david." + config.host),
        false
      );

      assert.deepEqual(
        extractPreviewTemplate("preview.foo.david." + config.host),
        "SITE:foo"
      );
      assert.deepEqual(
        extractPreviewTemplate("preview.my.foo.david." + config.host),
        "undefined:foo"
      );
    }).not.toThrow();
  });

  it("returns an error when the request has no host header", function (done) {
    this.req.get = function () {
      return undefined;
    };

    vhosts(this.req, this.res, function (err) {
      expect(err).toBeDefined();
      expect(err.code).toEqual("ENOENT");
      done();
    });
  });

  it("returns an error when no blog matches the host", function (done) {
    this.url("http://this-handle-does-not-exist." + config.host);

    vhosts(this.req, this.res, function (err) {
      expect(err).toBeDefined();
      expect(err.code).toEqual("ENOENT");
      done();
    });
  });

  it("returns an error when the blog is disabled", async function () {
    await this.blog.update({ isDisabled: true });
    this.url("http://" + this.blog.handle + "." + config.host);

    await new Promise((resolve) => {
      vhosts(this.req, this.res, function (err) {
        expect(err).toBeDefined();
        expect(err.code).toEqual("ENOENT");
        resolve();
      });
    });
  });

  // Note: blog.isUnpaid is checked alongside isDisabled below, but nothing
  // in the codebase ever sets that field on a Blog object (only on User -
  // see app/models/user/extend.js) - flagged separately as a likely dead
  // branch rather than tested here as if it worked.

  it("redirects the www variant of a custom domain to the apex", async function () {
    // A real, non-blot domain - the blog id itself contains characters
    // (e.g. underscores) that aren't valid in a domain name.
    var domain =
      "example-" + Math.random().toString(36).slice(2, 10) + ".com";

    await this.blog.update({ domain: domain });
    this.url("http://www." + domain);
    // Use https here so blog.forceSSL's http->https redirect (defaults to
    // true - see models/blog/defaults.js) doesn't take precedence over the
    // www->apex redirect this test is targeting; a real browser already on
    // https://www.<domain> hits exactly this path.
    this.req.protocol = "https";

    // vhosts() responds directly via res.redirect() for this branch and
    // never calls the `next` callback, so resolve on whichever fires.
    await new Promise((resolve) => {
      this.res.redirect.and.callFake(resolve);
      vhosts(this.req, this.res, resolve);
    });

    // Express's res.redirect(url) hard-codes 302 regardless of any prior
    // res.status() call, so the permanent-redirect status must be passed
    // to redirect() itself - assert the call shape that actually works.
    expect(this.res.redirect).toHaveBeenCalledWith(
      301,
      "https://" + domain + "/"
    );
  });

  it("redirects http to https when the blog has forceSSL enabled", async function () {
    await this.blog.update({ forceSSL: true });
    this.url("http://" + this.blog.handle + "." + config.host);
    this.req.protocol = "http";

    // vhosts() responds directly via res.redirect() for this branch and
    // never calls the `next` callback, so resolve on whichever fires.
    await new Promise((resolve) => {
      this.res.redirect.and.callFake(resolve);
      vhosts(this.req, this.res, resolve);
    });

    expect(this.res.redirect).toHaveBeenCalledWith(
      301,
      "https://" + this.blog.handle + "." + config.host + "/"
    );
  });

  it("does not force an https redirect when the request comes via Cloudflare", async function () {
    await this.blog.update({ forceSSL: true });
    this.url("http://" + this.blog.handle + "." + config.host);
    this.req.protocol = "http";
    this.req.headers = { "cf-connecting-ip": "1.2.3.4" };

    await new Promise((resolve, reject) => {
      vhosts(this.req, this.res, function (err) {
        if (err) return reject(err);
        resolve();
      });
    });

    expect(this.res.redirect).not.toHaveBeenCalled();
  });

  global.test.blog();

  beforeEach(function () {
    var ctx = this;

    ctx.url = function (url) {
      ctx.url = require("url").parse(url);
    };

    ctx.req = {
      get: function () {
        return ctx.url.hostname;
      },
      log: function () {},
      url: ctx.url.pathname,
      originalUrl: "/",
      protocol: ctx.url.protocol,
    };

    ctx.res = {
      set: function () {},
      removeHeader: function () {},
      status: jasmine.createSpy("status").and.callFake(function () {
        return ctx.res;
      }),
      redirect: jasmine.createSpy("redirect"),
    };
  });
});
