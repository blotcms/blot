describe("list", function () {
  require("./setup")({ createTemplate: true });

  var getTemplateList = require("../index").getTemplateList;

  it("lists all templates", async function () {
    var test = this;
    var result = await getTemplateList(test.blog.id);
    expect(result).toEqual(jasmine.any(Array));
    expect(result).toContain(test.template);
  });

  it("lists SITE-owned templates for every blog", async function () {
    var test = this;

    var ownerTemplates = await getTemplateList(test.blog.id);
    var otherTemplates = await getTemplateList("another:blog");

    var siteTemplateIDs = ownerTemplates
      .filter(function (template) {
        return template.owner === "SITE";
      })
      .map(function (template) {
        return template.id;
      });

    expect(siteTemplateIDs.length).toBeGreaterThan(0);
    siteTemplateIDs.forEach(function (id) {
      expect(
        otherTemplates.some(function (template) {
          return template.id === id;
        })
      ).toBe(true);
    });
  });

  it("lists blog-owned templates only for their owner", async function () {
    var test = this;

    var templates = await getTemplateList("another:blog");
    expect(
      templates.some(function (template) {
        return template.id === test.template.id;
      })
    ).toBe(false);
  });

  it("does not return an error if the owner does not exist", async function () {
    var result = await getTemplateList("nonexistent:blog");
    expect(result).toEqual(jasmine.any(Array));
  });

  it("returns a promise when called without a callback", async function () {
    var result = await getTemplateList(this.blog.id);
    expect(result).toContain(this.template);
  });
});
