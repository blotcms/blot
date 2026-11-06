describe("template", function () {
  require("./setup")({ createTemplate: true });

  var getMetadata = require("../index").getMetadata;

  it("gets a template", function (done) {
    var test = this;
    getMetadata(test.template.id, function (err, template) {
      expect(err).toBeNull();
      expect(template).toEqual(test.template);
      done();
    });
  });

  it("returns ENOENT when template does not exist", function (done) {
    getMetadata("nonexistent:template", function (err, template) {
      expect(err instanceof Error).toBe(true);
      expect(err.code).toEqual("ENOENT");
      expect(template).toBeFalsy();
      done();
    });
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
