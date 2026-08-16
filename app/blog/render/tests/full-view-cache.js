var Template = require("models/template");
var getCachedFullView = require("../full-view-cache");

describe("full view cache", function () {
  beforeEach(function () {
    getCachedFullView._clear();
  });

  it("reuses cached full view responses for identical inputs", function (done) {
    var response = [{ title: "Hello" }, { head: "" }, [], "text/html", "{{title}}"];

    spyOn(Template, "getFullView").and.callFake(function (
      blogID,
      templateID,
      viewName,
      callback
    ) {
      callback(null, response);
    });

    var options = {
      blog: { id: "blog-1", cacheID: 111 },
      template: { id: "template-1" },
      viewName: "entry.html",
    };

    getCachedFullView(options, function (err, firstResult) {
      expect(err).toBeNull();
      expect(firstResult).toEqual(response);
      expect(firstResult).not.toBe(response);

      getCachedFullView(options, function (secondErr, secondResult) {
        expect(secondErr).toBeNull();
        expect(secondResult).toEqual(response);
        expect(secondResult).not.toBe(response);
        expect(secondResult).not.toBe(firstResult);
        expect(Template.getFullView).toHaveBeenCalledTimes(1);
        done();
      });
    });
  });

  it("returns isolated copies so caller mutations do not taint cache", function (done) {
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

    var options = {
      blog: { id: "blog-1", cacheID: 111 },
      template: { id: "template-1" },
      viewName: "entry.html",
    };

    getCachedFullView(options, function (err, firstResult) {
      expect(err).toBeNull();

      firstResult[0].title = "Mutated";
      firstResult[2][0].id = "asset-2";

      getCachedFullView(options, function (secondErr, secondResult) {
        expect(secondErr).toBeNull();
        expect(secondResult[0].title).toBe("Original");
        expect(secondResult[2][0].id).toBe("asset-1");
        expect(Template.getFullView).toHaveBeenCalledTimes(1);
        done();
      });
    });
  });

  it("misses the cache when blog/template/view inputs differ", function (done) {
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

    getCachedFullView(
      {
        blog: { id: "blog-1", cacheID: 111 },
        template: { id: "template-1" },
        viewName: "entry.html",
      },
      function () {
        getCachedFullView(
          {
            blog: { id: "blog-2", cacheID: 111 },
            template: { id: "template-2" },
            viewName: "index.html",
          },
          function () {
            expect(Template.getFullView).toHaveBeenCalledTimes(2);
            done();
          }
        );
      }
    );
  });


  it("does not collide cache keys when input segments contain colons", function () {
    var firstKey = getCachedFullView._createCacheKey(
      { id: "foo:bar", cacheID: "baz" },
      { id: "qux" },
      "view"
    );

    var secondKey = getCachedFullView._createCacheKey(
      { id: "foo", cacheID: "bar:baz" },
      { id: "qux" },
      "view"
    );

    expect(firstKey).not.toBe(secondKey);
  });

  it("keeps null and undefined cache key behavior stable", function () {
    var keyWithNull = getCachedFullView._createCacheKey(
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
  it("recomputes when blog.cacheID changes", function (done) {
    spyOn(Template, "getFullView").and.callFake(function (
      blogID,
      templateID,
      viewName,
      callback
    ) {
      callback(null, [{ cacheID: Date.now() }, {}, [], "text/html", ""]);
    });

    getCachedFullView(
      {
        blog: { id: "blog-1", cacheID: 111 },
        template: { id: "template-1" },
        viewName: "entry.html",
      },
      function () {
        getCachedFullView(
          {
            blog: { id: "blog-1", cacheID: 222 },
            template: { id: "template-1" },
            viewName: "entry.html",
          },
          function () {
            expect(Template.getFullView).toHaveBeenCalledTimes(2);
            done();
          }
        );
      }
    );
  });
});
