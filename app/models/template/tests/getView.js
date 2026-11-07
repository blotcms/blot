describe("template", function () {
  require("./setup")({ createTemplate: true, createView: true });

  var getView = require("../index").getView;

  it("gets a view", async function () {
    var test = this;
    var savedView = await getView(test.template.id, test.view.name);
    expect(savedView.name).toEqual(test.view.name);
    expect(savedView.content).toEqual(test.view.content);
  });

  it("returns an error for a non-existent view", async function () {
    var test = this;
    var savedView;
    try {
      savedView = await getView(test.template.id, "");
      fail("should have thrown");
    } catch (err) {
      expect(err instanceof Error).toBe(true);
      expect(savedView).toBeFalsy();
    }
  });

  it("returns an error for a non-existent template", async function () {
    var test = this;
    var savedView;
    try {
      savedView = await getView("", test.view.name);
      fail("should have thrown");
    } catch (err) {
      expect(err instanceof Error).toBe(true);
      expect(savedView).toBeFalsy();
    }
  });

  it("returns a promise when called without a callback", async function () {
    var savedView = await getView(this.template.id, this.view.name);
    expect(savedView.name).toEqual(this.view.name);

    var error;
    try {
      await getView(this.template.id, "");
    } catch (e) {
      error = e;
    }
    expect(error instanceof Error).toBe(true);
  });
});
