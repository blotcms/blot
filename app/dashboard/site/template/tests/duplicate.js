describe("duplicate template route", function () {
  global.test.blog();

  const Template = require("models/template");
  const duplicateTemplate = require("../save/duplicate-template");

  beforeEach(async function () {
    const test = this;
    const name = "Original";

    await Template.create(test.blog.id, name, {});

    const templates = await Template.getTemplateList(test.blog.id);

    test.originalTemplate = templates.filter(function (template) {
      return template.name === name;
    })[0];
  });

  describe("of a template whose name fills the id", function () {
    // Template.create derives the id from makeSlug(name).slice(0, 30), so a
    // name this long leaves no room for a counter
    const longName = "My extremely long template name for testing";

    beforeEach(async function () {
      const test = this;

      await Template.create(test.blog.id, longName, {});

      const templates = await Template.getTemplateList(test.blog.id);

      test.longTemplate = templates.filter(function (template) {
        return template.name === longName;
      })[0];
    });

    it("still says it is a copy", async function () {
      // Room for ' copy' is made by trimming the name, never the suffix.
      // Trimming the whole thing eats the word first, leaving a copy which
      // does not say so and which parseCopyName cannot recognise later.
      const copy = await duplicateTemplate({
        owner: this.blog.id,
        template: this.longTemplate,
      });

      expect(copy.name).toMatch(/ copy$/);
      expect(copy.slug).toMatch(/-copy$/);

      const second = await duplicateTemplate({
        owner: this.blog.id,
        template: this.longTemplate,
      });

      expect(second.name).toMatch(/ copy 2$/);
      expect(second.slug).toMatch(/-copy-2$/);
    });

    it("does not collide with the template it came from", async function () {
      const copy = await duplicateTemplate({
        owner: this.blog.id,
        template: this.longTemplate,
      });

      expect(copy.id).not.toEqual(this.longTemplate.id);
    });

    it("stores a slug which matches the id", async function () {
      // writeToFolder names the template's directory after the stored slug
      // and readFromFolder turns that name back into an id. If they disagree,
      // enabling local editing on the copy can write it over the original.
      const copy = await duplicateTemplate({
        owner: this.blog.id,
        template: this.longTemplate,
      });

      expect(copy.slug).toEqual(copy.id.split(":").slice(1).join(":"));
    });

    it("can be duplicated more than once", async function () {
      const first = await duplicateTemplate({
        owner: this.blog.id,
        template: this.longTemplate,
      });

      // Without trimming the name, the counter falls outside the 30
      // characters the id is cut to, so every retry derives the same id and
      // duplication gives up after MAX_DEDUPLICATION_ATTEMPTS
      const second = await duplicateTemplate({
        owner: this.blog.id,
        template: this.longTemplate,
      });

      expect(second.id).not.toEqual(first.id);
      expect(second.slug).toEqual(second.id.split(":").slice(1).join(":"));
    });
  });

  it("deduplicates subsequent copies", async function () {
    const firstCopy = await duplicateTemplate({
      owner: this.blog.id,
      template: this.originalTemplate,
    });

    expect(firstCopy.name).toEqual("Original copy");
    expect(firstCopy.slug).toEqual("original-copy");

    const secondCopy = await duplicateTemplate({
      owner: this.blog.id,
      template: this.originalTemplate,
    });

    expect(secondCopy.name).toEqual("Original copy 2");
    expect(secondCopy.slug).toEqual("original-copy-2");

    const thirdCopy = await duplicateTemplate({
      owner: this.blog.id,
      template: this.originalTemplate,
    });

    expect(thirdCopy.name).toEqual("Original copy 3");
    expect(thirdCopy.slug).toEqual("original-copy-3");
  });
});
