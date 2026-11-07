describe("template", function () {
  require("./setup")({ createTemplate: true });

  var getMetadata = require("../index").getMetadata;

  it("gets a template", async function () {
    var test = this;
    var template = await getMetadata(test.template.id);
    expect(template).toEqual(test.template);
  });

  it("returns ENOENT when template does not exist", async function () {
    var template;
    try {
      template = await getMetadata("nonexistent:template");
      fail("should have thrown");
    } catch (err) {
      expect(err instanceof Error).toBe(true);
      expect(err.code).toEqual("ENOENT");
      expect(template).toBeFalsy();
    }
  });

  it("returns a promise when called without a callback", async function () {
    var template = await getMetadata(this.template.id);
    expect(template.id).toEqual(this.template.id);

    var error;
    try {
      await getMetadata("nonexistent:template");
    } catch (e) {
      error = e;
    }
    expect(error instanceof Error).toBe(true);
    expect(error.code).toEqual("ENOENT");
  });
});
