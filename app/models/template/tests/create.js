describe("template", function () {
  require("./setup")();

  var create = require("models/template/index").create;
  var getTemplateList = require("models/template/index").getTemplateList;
  var makeID = require("models/template/index").makeID;

  it("creates a template", async function () {
    await create(this.blog.id, "template", {});
  });

  // writeToFolder names a template's on-disk directory after its stored slug
  // and readFromFolder turns that name back into an id with makeID. If a
  // caller-supplied slug resolves to a different id than the template's own,
  // a locally edited copy is read back from its folder as another template
  // and overwrites it. The stored slug must always round-trip to the id.
  it("keeps the stored slug in step with the id", async function () {
    var blogID = this.blog.id;

    // A slug long enough that makeID's 30-character truncation shortens it,
    // deliberately unrelated to the name so the two cannot coincide.
    const template = await create(blogID, "A perfectly ordinary name", {
      slug: "a-deliberately-divergent-slug-that-is-really-quite-long",
    });

    expect(makeID(blogID, template.slug)).toEqual(template.id);
    expect(template.slug).toEqual(template.id.split(":").slice(1).join(":"));
  });

  // A local template is named after its folder, so create() is handed the
  // folder name as the slug. That name need not be slug-shaped, but it must
  // still resolve to the template's id or every folder sync would treat it
  // as a different template.
  it("leaves a folder-name slug which already resolves to the id untouched", async function () {
    var blogID = this.blog.id;
    var folderName = "My Local Theme";

    const template = await create(blogID, folderName, {
      slug: folderName,
      localEditing: true,
    });

    expect(makeID(blogID, template.slug)).toEqual(template.id);
    expect(template.slug).toEqual(folderName);
  });

  it("passes an error to the callback if you try to create a template with no name", async function () {
    let err;
    try {
      await create(this.blog.id, null, null);
      fail("should have thrown");
    } catch (e) {
      err = e;
    }
    expect(err).toEqual(jasmine.any(Error));
  });

  it("returns a promise when given no callback", async function () {
    const template = await create(this.blog.id, "promised", {});

    expect(template.name).toEqual("promised");
    await expectAsync(create(this.blog.id, "promised", {})).toBeRejectedWith(
      jasmine.objectContaining({ code: "EEXISTS" })
    );
  });

  it("creates a template whose name contains a slash", async function () {
    var test = this;
    var name = "template/folder";
    await create(test.blog.id, name, {});
    const templates = await getTemplateList(test.blog.id);

    expect(
      templates.filter(function (template) {
        return template.name === name;
      }).length
    ).toEqual(1);
  });

  it("creates multiple templates in parallel", async function () {
    var test = this;
    var templateNames = [];

    while (templateNames.length < 1000)
      templateNames.push(test.fake.random.uuid());

    await Promise.all(
      templateNames.map((templateName) =>
        create(test.blog.id, templateName, {})
      )
    );
    const templates = await getTemplateList(test.blog.id);

    expect(
      templates.filter(function (template) {
        return templateNames.indexOf(template.name) > -1;
      }).length
    ).toEqual(1000);
  });

  it("returns an error if you try to create a template which already exists", async function () {
    var name = "template";
    var test = this;
    await create(this.blog.id, name, {});
    let err;
    try {
      await create(test.blog.id, name, {});
      fail("should have thrown");
    } catch (e) {
      err = e;
    }
    expect(err instanceof Error).toEqual(true);
  });

  it("creates a template from an existing template", async function () {
    var test = this;
    var blogID = test.blog.id;
    var original = "template";
    var cloned = Date.now().toString(); // prevents same name as original
    var description = "A test template description";
    var originalTemplate, clonedTemplate;

    await create(blogID, original, {
      locals: { description: description },
    });

    let templates = await getTemplateList(test.blog.id);
    originalTemplate = templates.filter(function (template) {
      return template.name === original;
    })[0];

    await create(blogID, cloned, { cloneFrom: originalTemplate.id });

    templates = await getTemplateList(test.blog.id);
    clonedTemplate = templates.filter(function (template) {
      return template.name === cloned;
    })[0];

    expect(originalTemplate.locals).toEqual(clonedTemplate.locals);
  });

  // There is a bug with the clone function at the moment
  // It does a truthy check against an empty object in the
  // case of an attempt to clone a non-existent template.
  // if (err || !allViews)  where all views is {}
  // Fix this in future and enable the spec.
  xit("returns an error if you try to clone a template that does not exist", async function () {
    let err;
    try {
      await create(this.blog.id, "template", {
        cloneFrom: "nonexistent:template",
      });
      fail("should have thrown");
    } catch (e) {
      console.log(e);
      err = e;
    }
    expect(err instanceof Error).toBe(true);
  });
});
