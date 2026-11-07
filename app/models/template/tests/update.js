describe("template", function () {
  require("./setup")({ createTemplate: true });

  var update = require("../index").update;
  var getMetadata = require("../index").getMetadata;

  it("updates a template", async function () {
    var test = this;
    var updates = { description: "Updated template description" };
    await update(test.blog.id, test.template.name, updates);
    var template = await getMetadata(test.template.id);
    expect(template.description).toEqual(updates.description);
  });

  // Enable this once we have decided whether or not setMetadata
  // should be used for new templates. This might break uses of the
  // api internally so be carefull.
  xit("throws an error if you update a template which does not exist", async function () {
    try {
      await update(this.blog.owner, "nonexistent-template", {});
      fail("should have thrown");
    } catch (err) {
      expect(err instanceof Error).toEqual(true);
    }
  });
});
