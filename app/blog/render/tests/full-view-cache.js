const Template = require("models/template");
const getCachedFullView = require("../full-view-cache");

describe("full view cache", function () {
  beforeEach(function () {
    getCachedFullView._clear();
  });

  it("reuses cached full view responses for identical inputs", async function () {
    const response = [
      { title: "Hello" },
      { head: "" },
      [],
      "text/html",
      "{{title}}",
    ];

    spyOn(Template, "getFullView").and.callFake(function (
      blogID,
      templateID,
      viewName,
      callback
    ) {
      callback(null, response);
    });

    const options = {
      blog: { id: "blog-1", cacheID: 111 },
      template: { id: "template-1" },
      viewName: "entry.html",
    };

    const firstResult = await getCachedFullView(options);
    expect(firstResult).toEqual(response);
    expect(firstResult).not.toBe(response);

    const secondResult = await getCachedFullView(options);
    expect(secondResult).toEqual(response);
    expect(secondResult).not.toBe(response);
    expect(secondResult).not.toBe(firstResult);
    expect(Template.getFullView).toHaveBeenCalledTimes(1);
  });

  it("returns isolated copies so caller mutations do not taint cache", async function () {
    spyOn(Template, "getFullView").and.callFake(function (
      blogID,
      templateID,
      viewName,
      callback
    ) {
      callback(null, [
        { title: "Original" },
        { head: "" },
        [{ id: "asset-1" }],
        "text/html",
        "{{title}}",
      ]);
    });

    const options = {
      blog: { id: "blog-1", cacheID: 111 },
      template: { id: "template-1" },
      viewName: "entry.html",
    };

    const firstResult = await getCachedFullView(options);
    firstResult[0].title = "Mutated";
    firstResult[2][0].id = "asset-2";

    const secondResult = await getCachedFullView(options);
    expect(secondResult[0].title).toBe("Original");
    expect(secondResult[2][0].id).toBe("asset-1");
    expect(Template.getFullView).toHaveBeenCalledTimes(1);
  });

  it("misses the cache when blog/template/view inputs differ", async function () {
    spyOn(Template, "getFullView").and.callFake(function (
      blogID,
      templateID,
      viewName,
      callback
    ) {
      callback(null, [
        { blogID: blogID, templateID: templateID, viewName: viewName },
        {},
        [],
        "text/html",
        "",
      ]);
    });

    await getCachedFullView({
      blog: { id: "blog-1", cacheID: 111 },
      template: { id: "template-1" },
      viewName: "entry.html",
    });
    await getCachedFullView({
      blog: { id: "blog-2", cacheID: 111 },
      template: { id: "template-2" },
      viewName: "index.html",
    });

    expect(Template.getFullView).toHaveBeenCalledTimes(2);
  });

  it("does not collide cache keys when input segments contain colons", function () {
    const firstKey = getCachedFullView._createCacheKey(
      { id: "foo:bar", cacheID: "baz" },
      { id: "qux" },
      "view"
    );

    const secondKey = getCachedFullView._createCacheKey(
      { id: "foo", cacheID: "bar:baz" },
      { id: "qux" },
      "view"
    );

    expect(firstKey).not.toBe(secondKey);
  });

  it("keeps null and undefined cache key behavior stable", function () {
    const keyWithNull = getCachedFullView._createCacheKey(
      { id: null, cacheID: undefined },
      { id: undefined },
      null
    );

    expect(keyWithNull).toBe(
      JSON.stringify({
        blogID: "null",
        cacheID: "undefined",
        templateID: "undefined",
        viewName: "null",
      })
    );
  });

  it("recomputes when blog.cacheID changes", async function () {
    spyOn(Template, "getFullView").and.callFake(function (
      blogID,
      templateID,
      viewName,
      callback
    ) {
      callback(null, [{ cacheID: Date.now() }, {}, [], "text/html", ""]);
    });

    await getCachedFullView({
      blog: { id: "blog-1", cacheID: 111 },
      template: { id: "template-1" },
      viewName: "entry.html",
    });
    await getCachedFullView({
      blog: { id: "blog-1", cacheID: 222 },
      template: { id: "template-1" },
      viewName: "entry.html",
    });

    expect(Template.getFullView).toHaveBeenCalledTimes(2);
  });
});
