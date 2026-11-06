const { promisify } = require("util");
const fullViewCache = require("../fullViewCache");

// The old options-object call, kept so the cases below read as before
function getCachedFullView({ blog, template, viewName }) {
  return promisify(fullViewCache)(blog.id, template.id, viewName, {
    blogCacheID: blog.cacheID,
    templateCacheID: template.cacheID === undefined ? null : template.cacheID,
  });
}
getCachedFullView._createCacheKey = function (blog, template, viewName) {
  return fullViewCache._createCacheKey(
    blog.id,
    blog.cacheID,
    template.id,
    template.cacheID,
    viewName
  );
};
getCachedFullView._clear = fullViewCache._clear;

describe("Template.getFullView cache", function () {
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

    spyOn(fullViewCache, "_build").and.callFake(
      function (blogID, templateID, viewName, callback) {
        callback(null, response);
      }
    );

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
    expect(fullViewCache._build).toHaveBeenCalledTimes(1);
  });

  it("returns isolated copies so caller mutations do not taint cache", async function () {
    spyOn(fullViewCache, "_build").and.callFake(
      function (blogID, templateID, viewName, callback) {
        callback(null, [
          { title: "Original" },
          { head: "" },
          [{ id: "asset-1" }],
          "text/html",
          "{{title}}",
        ]);
      }
    );

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
    expect(fullViewCache._build).toHaveBeenCalledTimes(1);
  });

  it("misses the cache when blog/template/view inputs differ", async function () {
    spyOn(fullViewCache, "_build").and.callFake(
      function (blogID, templateID, viewName, callback) {
        callback(null, [
          { blogID: blogID, templateID: templateID, viewName: viewName },
          {},
          [],
          "text/html",
          "",
        ]);
      }
    );

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

    expect(fullViewCache._build).toHaveBeenCalledTimes(2);
  });

  it("misses when the template's cacheID changes", async function () {
    spyOn(fullViewCache, "_build").and.callFake(
      function (blogID, templateID, viewName, callback) {
        callback(null, [{}, {}, [], "text/html", "{{title}}"]);
      }
    );

    const blog = { id: "blog-1", cacheID: 111 };

    await getCachedFullView({
      blog,
      template: { id: "template-1", cacheID: "a" },
      viewName: "entry.html",
    });
    await getCachedFullView({
      blog,
      template: { id: "template-1", cacheID: "b" },
      viewName: "entry.html",
    });

    expect(fullViewCache._build).toHaveBeenCalledTimes(2);
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
        templateCacheID: "undefined",
        viewName: "null",
      })
    );
  });

  it("recomputes when blog.cacheID changes", async function () {
    spyOn(fullViewCache, "_build").and.callFake(
      function (blogID, templateID, viewName, callback) {
        callback(null, [{ cacheID: Date.now() }, {}, [], "text/html", ""]);
      }
    );

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

    expect(fullViewCache._build).toHaveBeenCalledTimes(2);
  });

  it("reads the cacheIDs from Redis when the caller doesn't pass them", async function () {
    const client = require("models/client");
    spyOn(fullViewCache, "_build").and.callFake(function (b, t, v, callback) {
      callback(null, [{}, {}, [], "text/html", ""]);
    });
    spyOn(client, "hGet").and.callFake(async function (key) {
      return key === "blog:blog-1:info" ? "111" : "a";
    });

    await promisify(fullViewCache)("blog-1", "blog-1:t", "entry.html");
    await promisify(fullViewCache)("blog-1", "blog-1:t", "entry.html");

    expect(fullViewCache._build).toHaveBeenCalledTimes(1);
    expect(client.hGet).toHaveBeenCalledWith("blog:blog-1:info", "cacheID");
    expect(client.hGet).toHaveBeenCalledWith(
      "template:blog-1:t:info",
      "cacheID"
    );
  });
});
