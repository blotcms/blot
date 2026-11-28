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

describe("template getView with a compressed source", function () {
  require("./setup")({ createTemplate: true, createView: true });

  var client = require("models/client");
  var key = require("../key");
  var viewContent = require("../util/viewContent");
  var getView = require("../index").getView;

  it("reads a view whose source is compressed, again from the cache", async function () {
    var source = "<h1>{{title}}</h1>\n".repeat(200);
    var viewKey = key.view(this.template.id, this.view.name);

    await client
      .multi()
      .hSet(viewKey, viewContent.FIELD, await viewContent.pack(source))
      .hDel(viewKey, "content")
      .exec();

    for (var i = 0; i < 3; i++) {
      var view = await getView(this.template.id, this.view.name);
      expect(view.content).toEqual(source);
      expect(view.name).toEqual(this.view.name);
      expect(view[viewContent.FIELD]).toBeUndefined();
      expect(typeof view.partials).toEqual("object");
    }
  });
});
