describe("template loader", function () {
  global.test.blog();

  const Template = require("models/template");
  const makeSlug = require("helper/makeSlug");
  const loader = require("../load/template");

  afterEach(function () {
    if (Template.getMetadata.and) Template.getMetadata.and.callThrough();
  });

  it("hydrates a fallback template when metadata is missing", async function () {
    const slugParam = "Missing Template";
    const expectedSlug = makeSlug(slugParam);

    spyOn(Template, "getMetadata").and.callFake(function (_id, callback) {
      callback(null, null);
    });

    const req = {
      blog: this.blog,
      params: { templateSlug: slugParam },
      protocol: "https",
      hostname: "example.com",
      baseUrl: "/dashboard/site/template",
    };

    const res = {
      locals: {
        breadcrumbs: { add: jasmine.createSpy("add") },
      },
    };

    const next = jasmine.createSpy("next");

    await loader(req, res, next);

    expect(next).toHaveBeenCalledWith();
    expect(res.locals.templateMissing).toBe(true);
    expect(req.template).toBeDefined();
    expect(res.locals.template).toBe(req.template);
    expect(req.template.slug).toEqual(expectedSlug);
    expect(req.template.id).toEqual(Template.makeID(this.blog.id, expectedSlug));
    expect(req.template.locals).toEqual({});
    expect(req.template.partials).toEqual({});
    expect(req.template.previewPath).toEqual("");
    expect(res.locals.preview).toEqual(res.locals.previewOrigin);
    expect(res.locals.breadcrumbs.add).toHaveBeenCalledWith(
      req.template.name,
      req.template.slug
    );
  });

  it("uses the local folder name for locally edited template breadcrumbs", async function () {
    const folderName = "jolly-5";
    const packageName = "Jolly-5";

    spyOn(Template, "getMetadata").and.callFake(function (id, callback) {
      callback(
        null,
        id === Template.makeID(this.blog.id, folderName)
          ? {
              owner: this.blog.id,
              id: Template.makeID(this.blog.id, folderName),
              slug: folderName,
              name: packageName,
              localEditing: true,
            }
          : null
      );
    }.bind(this));

    const req = {
      blog: this.blog,
      params: { templateSlug: folderName },
      protocol: "https",
      hostname: "example.com",
      baseUrl: "/dashboard/site/template",
    };

    const res = {
      locals: {
        breadcrumbs: { add: jasmine.createSpy("add") },
      },
    };

    await loader(req, res, jasmine.createSpy("next"));

    expect(req.template.displayName).toBe(folderName);
    expect(req.template.name).toBe(packageName);
    expect(res.locals.breadcrumbs.add).toHaveBeenCalledWith(
      folderName,
      folderName
    );
  });
});
