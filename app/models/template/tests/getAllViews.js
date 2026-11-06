describe("template", function () {
  require("./setup")({ createTemplate: true, createView: true });

  var getAllViews = require("../index").getAllViews;

  it("gets alls views", async function () {
    var test = this;
    const { views } = await getAllViews(test.template.id);
    expect(views).toEqual(jasmine.any(Object));
    expect(views[test.view.name].content).toEqual(test.view.content);
  });

  it("resolves to the views and the template metadata", async function () {
    var test = this;
    const result = await getAllViews(test.template.id);
    expect(Object.keys(result).sort()).toEqual(["metadata", "views"]);
    expect(result.metadata.id).toEqual(test.template.id);
  });

  it("rejects with ENOENT for a template that does not exist", async function () {
    let error;
    try {
      await getAllViews("SITE:does-not-exist");
    } catch (err) {
      error = err;
    }
    expect(error && error.code).toEqual("ENOENT");
  });

  xit("returns an error for a non-existent view", function (done) {
    var test = this;
    getAllViews(test.template.id, "", function (err, savedView) {
      expect(err instanceof Error).toBe(true);
      expect(savedView).toBeFalsy();
      done();
    });
  });

  xit("returns an error for a non-existent template", function (done) {
    var test = this;
    getAllViews("", test.view.name, function (err, savedView) {
      expect(err instanceof Error).toBe(true);
      expect(savedView).toBeFalsy();
      done();
    });
  });
});
