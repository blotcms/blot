describe("install template route", function () {
  global.test.blogs(2);

  const Blog = require("models/blog");
  const Template = require("models/template");
  const router = require("../index");

  const installHandler = router.stack
    .find(function (layer) {
      return layer.route && layer.route.path === "/:templateSlug/install";
    })
    .route.stack.find(function (layer) {
      return layer.method === "post";
    }).handle;

  function runInstall(blog, templateID) {
    return new Promise(function (resolve) {
      const req = {
        blog: blog,
        body: { template: templateID },
        params: { templateSlug: "installed-template" },
      };
      const res = {
        message: jasmine.createSpy("message"),
        redirect: jasmine.createSpy("redirect"),
      };

      installHandler(req, res, function (err) {
        resolve({ err: err, res: res });
      });

      if (res.redirect.calls.any()) resolve({ res: res });
    });
  }

  beforeEach(function () {
    spyOn(Blog, "set").and.callFake(function (_blogID, _updates, callback) {
      callback();
    });
    spyOn(Template, "removeEnabledFromAllTemplates").and.callFake(function (
      _blogID,
      callback
    ) {
      callback();
    });
  });

  it("installs a template owned by the requesting blog", async function () {
    const blog = this.blogs[0];
    const templateID = `${blog.id}:owned-template`;

    const result = await runInstall(blog, templateID);

    expect(result.err).toBeUndefined();
    expect(Blog.set).toHaveBeenCalledWith(
      blog.id,
      { template: templateID },
      jasmine.any(Function)
    );
    expect(result.res.redirect).toHaveBeenCalledWith(
      "/sites/" + blog.handle + "/template/installed-template"
    );
    expect(result.res.message).not.toHaveBeenCalled();
  });

  it("installs a shared SITE template", async function () {
    const blog = this.blogs[0];
    const templateID = "SITE:shared-template";

    const result = await runInstall(blog, templateID);

    expect(result.err).toBeUndefined();
    expect(Blog.set).toHaveBeenCalledWith(
      blog.id,
      { template: templateID },
      jasmine.any(Function)
    );
    expect(result.res.redirect).toHaveBeenCalledWith(
      "/sites/" + blog.handle + "/template/installed-template"
    );
    expect(result.res.message).not.toHaveBeenCalled();
  });

  it("rejects an existing template owned by a different blog", async function () {
    const blog = this.blogs[0];
    const otherBlog = this.blogs[1];
    const otherTemplate = await new Promise(function (resolve, reject) {
      Template.create(otherBlog.id, "Existing template", {}, function (
        err,
        template
      ) {
        if (err) return reject(err);
        resolve(template);
      });
    });

    const originalTemplate = await new Promise(function (resolve, reject) {
      Blog.get({ id: blog.id }, function (err, value) {
        if (err) return reject(err);
        resolve(value.template);
      });
    });
    Blog.set.calls.reset();

    const result = await runInstall(blog, otherTemplate.id);

    expect(result.err).toEqual(jasmine.any(Error));
    expect(result.err.status).toBe(403);
    expect(Blog.set).not.toHaveBeenCalled();

    const storedBlog = await new Promise(function (resolve, reject) {
      Blog.get({ id: blog.id }, function (err, value) {
        if (err) return reject(err);
        resolve(value);
      });
    });
    expect(storedBlog.template).toBe(originalTemplate);
  });

  it("rejects malformed and partially matching owner prefixes", async function () {
    const blog = this.blogs[0];
    const malformedValues = [
      { id: "not-a-string" },
      `${blog.id}another-blog:template`,
    ];

    const expectedStatuses = [400, 403];

    Blog.set.calls.reset();

    for (let index = 0; index < malformedValues.length; index++) {
      const value = malformedValues[index];
      const result = await runInstall(blog, value);
      expect(result.err).toEqual(jasmine.any(Error));
      expect(result.err.status).toBe(expectedStatuses[index]);
    }

    expect(Blog.set).not.toHaveBeenCalled();
  });
});
