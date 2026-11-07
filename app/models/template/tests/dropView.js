describe("template", function () {
  require("./setup")({ createTemplate: true, createView: true });

  var dropView = require("../index").dropView;
  var getAllViews = require("../index").getAllViews;
  var getMetadata = require("../index").getMetadata;
  var client = require("models/client");

  it("dropView removes a view", async function () {
    await dropView(this.template.id, this.view.name);
  });

  it("dropView returns a promise when given no callback", async function () {
    const result = await dropView(this.template.id, this.view.name);

    expect(result).toEqual("Deleted " + this.template.id);
    await expectAsync(
      dropView(this.template.id, this.view.name)
    ).toBeRejected();
  });

  it("dropView gives the template a new cache ID", async function () {
    var test = this;
    const before = await getMetadata(test.template.id);
    await dropView(test.template.id, test.view.name);
    const after = await getMetadata(test.template.id);
    expect(after.cacheID).toEqual(jasmine.any(String));
    expect(after.cacheID).not.toEqual(before.cacheID);
  });

  it("dropView removes a view from the list of views", async function () {
    var test = this;
    const { views } = await getAllViews(test.template.id);
    expect(views[test.view.name].content).toEqual(test.view.content);
    await dropView(test.template.id, test.view.name);
    const { views: allViews } = await getAllViews(test.template.id);
    expect(allViews).toEqual({});
  });

  async function expectKeyDeleted(searchPattern, templateID, viewName) {
    const before = await client.keys(searchPattern);
    expect(before.length).toEqual(1);
    await dropView(templateID, viewName);
    const after = await client.keys(searchPattern);
    expect(after).toEqual([]);
  }

  it("dropView removes the key for the view", async function () {
    var test = this;
    await expectKeyDeleted(
      "template:" + test.template.id + ":view:*",
      test.template.id,
      test.view.name
    );
  });

  it("dropView removes the URL key for the view", async function () {
    var test = this;
    await expectKeyDeleted(
      "template:" + test.template.id + ":url:*",
      test.template.id,
      test.view.name
    );
  });

  it("dropView removes the URL patterns key for the view", async function () {
    var test = this;
    await expectKeyDeleted(
      "template:" + test.template.id + ":url_patterns",
      test.template.id,
      test.view.name
    );
  });

  it("dropView returns an error when the template does not exist", async function () {
    var test = this;
    let err;
    try {
      await dropView("nonexistent:template", test.view.name);
      fail("should have thrown");
    } catch (e) {
      err = e;
    }
    expect(err instanceof Error).toBe(true);
    expect(err.code).toEqual("ENOENT");
  });
});
