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

  xit("returns an error for a non-existent view", async function () {
    var test = this;
    let error;
    let savedView;
    try {
      savedView = await getAllViews(test.template.id, "");
      fail("should have thrown");
    } catch (err) {
      error = err;
    }
    expect(error instanceof Error).toBe(true);
    expect(savedView).toBeFalsy();
  });

  xit("returns an error for a non-existent template", async function () {
    var test = this;
    let error;
    let savedView;
    try {
      savedView = await getAllViews("", test.view.name);
      fail("should have thrown");
    } catch (err) {
      error = err;
    }
    expect(error instanceof Error).toBe(true);
    expect(savedView).toBeFalsy();
  });
});
