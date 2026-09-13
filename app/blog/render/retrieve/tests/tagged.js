describe("tagged block", function () {
  require("blog/tests/util/setup")();

  it("lists entries for a single tag", async function () {
    await this.write({
      path: "/first.txt",
      content: "Title: First\nTags: foo\n\nFirst body",
    });
    await this.write({
      path: "/second.txt",
      content: "Title: Second\nTags: foo\n\nSecond body",
    });
    await this.write({
      path: "/other.txt",
      content: "Title: Other\nTags: bar\n\nOther body",
    });

    await this.template({
      "tagged.html": `<ul>{{#tagged}}{{#entries}}<li>{{title}}</li>{{/entries}}{{/tagged}}</ul>`,
    });

    const res = await this.get("/tagged/foo");
    const body = await res.text();

    expect(res.status).toEqual(200);
    expect(body.trim()).toEqual("<ul><li>Second</li><li>First</li></ul>");
  });

  it("fetches tagged entries once when a view binds both {{#entries}} and {{#tagged}}", async function () {
    await this.write({
      path: "/first.txt",
      content: "Title: First\nTags: foo\n\nFirst body",
    });
    await this.write({
      path: "/second.txt",
      content: "Title: Second\nTags: foo\n\nSecond body",
    });

    // routes/tagged.js always fetches the {{#entries}} page; a view that
    // also references {{#tagged}} must not trigger a second
    // fetchTaggedEntries/Entry.get pass. See
    // https://github.com/davidmerfield/blot/issues/1844
    await this.template({
      "tagged.html":
        "{{#entries}}{{title}}-e {{/entries}}{{#tagged}}{{#entries}}{{title}}-t {{/entries}}{{/tagged}}",
    });

    // Publishing/indexing the entries above also calls Entry.get - only spy
    // once that's done, so the count below reflects just the request.
    const Entry = require("models/entry");
    spyOn(Entry, "get").and.callThrough();

    const res = await this.get("/tagged/foo");
    const body = await res.text();

    expect(res.status).toEqual(200);
    expect(body).toContain("Second-e");
    expect(body).toContain("Second-t");
    expect(Entry.get).toHaveBeenCalledTimes(1);
  });

  it('does not leak entries across an "undefined" string path_prefix set on the tagged.html view', async function () {
    await this.write({
      path: "/undefined/inside.txt",
      content: "Title: Inside\nTags: foo\n\nInside body",
    });
    await this.write({
      path: "/elsewhere/outside.txt",
      content: "Title: Outside\nTags: foo\n\nOutside body",
    });

    // A per-VIEW path_prefix (as opposed to a template-level one) isn't
    // visible to routes/tagged.js's own fetch, which runs before
    // render/middleware.js merges the view's locals in. That fetch's
    // (unfiltered) result must not collide, via key serialization, with
    // the later fetch that resolves the view's literal string
    // path_prefix: "undefined" - String(undefined) === "undefined" would
    // make the two indistinguishable. See
    // https://github.com/davidmerfield/blot/issues/1844
    await this.template(
      {
        "tagged.html":
          "{{#entries}}{{title}}-e {{/entries}}{{#tagged}}{{#entries}}{{title}}-t {{/entries}}{{/tagged}}",
      },
      { views: { "tagged.html": { locals: { path_prefix: "undefined" } } } }
    );

    const res = await this.get("/tagged/foo");
    const body = await res.text();

    expect(res.status).toEqual(200);
    // The route's own fetch runs before the view's path_prefix is
    // resolved, so the top-level {{#entries}} local stays unfiltered.
    expect(body).toContain("Inside-e");
    expect(body).toContain("Outside-e");
    // {{#tagged}}{{#entries}} must only include the "/undefined/" folder.
    expect(body).toContain("Inside-t");
    expect(body).not.toContain("Outside-t");
  });

  it("keeps existing tagged behavior when path_prefix is not set", async function () {
    await this.write({
      path: "/blog/one.txt",
      content: "Title: One\nTags: foo\n\nOne body",
    });
    await this.write({
      path: "/notes/two.txt",
      content: "Title: Two\nTags: foo\n\nTwo body",
    });

    await this.template({
      "tagged.html": `<ul>{{#tagged}}{{#entries}}<li>{{title}}</li>{{/entries}}{{/tagged}}</ul>`,
    });

    const res = await this.get("/tagged/foo");
    const body = await res.text();

    expect(res.status).toEqual(200);
    expect(body.trim()).toEqual("<ul><li>Two</li><li>One</li></ul>");
  });

  it("exposes metadata and helpers for the current tag", async function () {
    await this.write({ path: "/a.txt", content: "Tags: Featured\n\nAlpha" });

    await this.template({
      "tagged.html": `{{#tagged}}{{tag}}|{{#tagged.Featured}}upper{{/tagged.Featured}}|{{#tagged.featured}}lower{{/tagged.featured}}|{{#is.featured}}alias{{/is.featured}}{{/tagged}}`,
    });

    const res = await this.get("/tagged/Featured");
    const body = await res.text();

    expect(res.status).toEqual(200);
    expect(body.trim()).toEqual("Featured|upper|lower|alias");
  });

  it("filters entries by the intersection of multiple tags", async function () {
    await this.write({
      path: "/one.txt",
      content: "Title: One\nTags: foo\n\nOne body",
    });
    await this.write({
      path: "/two.txt",
      content: "Title: Two\nTags: foo, bar\n\nTwo body",
    });
    await this.write({
      path: "/three.txt",
      content: "Title: Three\nTags: bar\n\nThree body",
    });
    await this.write({
      path: "/four.txt",
      content: "Title: Four\nTags: foo, bar\n\nFour body",
    });

    await this.template({
      "entries.html": `<p>{{#tagged}}{{tag}}:{{#entries}}{{title}}|{{/entries}}{{/tagged}}</p>`,
    });

    const res = await this.get("/?tag=foo&tag=bar");
    const body = await res.text();

    expect(res.status).toEqual(200);
    expect(body.trim()).toEqual("<p>foo + bar:Four|Two|</p>");
  });

  it("filters tagged entries by path_prefix", async function () {
    await this.write({
      path: "/blog/one.txt",
      content: "Title: One\nTags: foo\n\nOne body",
    });
    await this.write({
      path: "/notes/two.txt",
      content: "Title: Two\nTags: foo\n\nTwo body",
    });
    await this.write({
      path: "/blog/three.txt",
      content: "Title: Three\nTags: foo\n\nThree body",
    });

    await this.template(
      {
        "tagged.html": `<ul>{{#tagged}}{{#entries}}<li>{{title}}</li>{{/entries}}{{/tagged}}</ul>`,
      },
      {
        locals: {
          path_prefix: "/blog/",
        },
      },
    );

    const res = await this.get("/tagged/foo");
    const body = await res.text();

    expect(res.status).toEqual(200);
    expect(body.trim()).toEqual("<ul><li>Three</li><li>One</li></ul>");
  });

  it("excludes pages from tagged listings and pagination totals", async function () {
    await this.write({
      path: "/work/post.txt",
      content: "Title: Car post\nTags: automotive\n\nPost body",
    });
    await this.write({
      path: "/work/page.txt",
      content: "Title: Car page\nTags: automotive\nPage: yes\n\nPage body",
    });

    await this.template(
      {
        "tagged.html": `{{#tagged}}{{total}}|{{pagination.total}}|{{#entries}}{{title}}{{/entries}}{{/tagged}}`,
      },
      {
        views: {
          "tagged.html": {
            url: ["/work/tagged/:tag", "/work/tagged/:tag/page/:page"],
          },
        },
        locals: {
          path_prefix: "/work/",
          tagged_page_size: 1,
        },
      },
    );

    const res = await this.get("/work/tagged/automotive");
    const body = await res.text();

    expect(res.status).toEqual(200);
    expect(body.trim()).toEqual("1|1|Car post");
  });

  it("treats empty and whitespace path_prefix as disabled filtering", async function () {
    await this.write({
      path: "/blog/one.txt",
      content: "Title: One\nTags: foo\n\nOne body",
    });
    await this.write({
      path: "/notes/two.txt",
      content: "Title: Two\nTags: foo\n\nTwo body",
    });

    await this.template(
      {
        "tagged.html": `<ul>{{#tagged}}{{#entries}}<li>{{title}}</li>{{/entries}}{{/tagged}}</ul>`,
      },
      {
        locals: {
          path_prefix: "   ",
        },
      },
    );

    const res = await this.get("/tagged/foo");
    const body = await res.text();

    expect(res.status).toEqual(200);
    expect(body.trim()).toEqual("<ul><li>Two</li><li>One</li></ul>");
  });

  it("normalizes path_prefix values that are missing a leading slash", async function () {
    await this.write({
      path: "/blog/one.txt",
      content: "Title: One\nTags: foo\n\nOne body",
    });
    await this.write({
      path: "/notes/two.txt",
      content: "Title: Two\nTags: foo\n\nTwo body",
    });

    await this.template(
      {
        "tagged.html": `<ul>{{#tagged}}{{#entries}}<li>{{title}}</li>{{/entries}}{{/tagged}}</ul>`,
      },
      {
        locals: {
          path_prefix: "blog/",
        },
      },
    );

    const res = await this.get("/tagged/foo");
    const body = await res.text();

    expect(res.status).toEqual(200);
    expect(body.trim()).toEqual("<ul><li>One</li></ul>");
  });

  it("respects trailing slash path_prefix boundaries", async function () {
    await this.write({
      path: "/blog/one.txt",
      content: "Title: One\nTags: foo\n\nOne body",
    });
    await this.write({
      path: "/blog-two.txt",
      content: "Title: Two\nTags: foo\n\nTwo body",
    });

    await this.template(
      {
        "tagged.html": `<ul>{{#tagged}}{{#entries}}<li>{{title}}</li>{{/entries}}{{/tagged}}</ul>`,
      },
      {
        locals: {
          path_prefix: "/blog/",
        },
      },
    );

    const res = await this.get("/tagged/foo");
    const body = await res.text();

    expect(res.status).toEqual(200);
    expect(body.trim()).toEqual("<ul><li>One</li></ul>");
  });

  it("ignores non-string entry IDs when filtering by path_prefix", function (done) {
    const tagged = require("blog/render/retrieve/tagged");
    const Tags = require("models/tags");
    const Entry = require("models/entry");

    spyOn(Tags, "get").and.callFake(function (blogID, slug, callback) {
      callback(null, ["/blog/one.txt", 7, null, "/notes/two.txt"], "foo", 4);
    });

    spyOn(Entry, "get").and.callFake(function (blogID, entryIDs, callback) {
      expect(entryIDs).toEqual(["/blog/one.txt"]);
      callback([{ id: "/blog/one.txt", title: "One", dateStamp: 1 }]);
    });

    const req = {
      blog: { id: this.blog.id },
      query: { tag: "foo" },
      params: {},
      template: { locals: {} },
    };

    const res = {
      locals: { path_prefix: "/blog/" },
    };

    tagged(req, res, function (err, result) {
      expect(err).toBeNull();
      expect(result.entryIDs).toEqual(["/blog/one.txt"]);
      expect(result.total).toBe(1);
      done();
    });
  });

  it("paginates tagged entries using filtered totals when path_prefix is set", async function () {
    await this.write({
      path: "/blog/one.txt",
      content: "Title: One\nTags: foo\n\nOne body",
    });
    await this.write({
      path: "/blog/two.txt",
      content: "Title: Two\nTags: foo\n\nTwo body",
    });
    await this.write({
      path: "/notes/three.txt",
      content: "Title: Three\nTags: foo\n\nThree body",
    });

    await this.template(
      {
        "tagged.html": `{{#tagged}}{{total}}|{{pagination.total}}|{{pagination.current}}|{{#entries}}{{title}}{{/entries}}{{/tagged}}`,
      },
      {
        locals: {
          path_prefix: "/blog/",
          tagged_page_size: 1,
        },
      },
    );

    const res = await this.get("/tagged/foo/page/2");
    const body = await res.text();

    expect(res.status).toEqual(200);
    expect(body.trim()).toEqual("2|2|2|One");
  });

  it("paginates multi-tag intersections without path_prefix filtering", async function () {
    await this.write({
      path: "/one.txt",
      content: "Title: One\nTags: foo, bar\n\nOne body",
    });
    await this.write({
      path: "/two.txt",
      content: "Title: Two\nTags: foo, bar\n\nTwo body",
    });
    await this.write({
      path: "/three.txt",
      content: "Title: Three\nTags: foo\n\nThree body",
    });

    await this.template(
      {
        "tagged.html": `{{#tagged}}{{total}}|{{pagination.total}}|{{pagination.current}}|{{#entries}}{{title}}{{/entries}}{{/tagged}}`,
      },
      {
        locals: {
          tagged_page_size: 1,
        },
      },
    );

    const res = await this.get("/tagged/foo/page/2?tag=foo&tag=bar");
    const body = await res.text();

    expect(res.status).toEqual(200);
    expect(body.trim()).toEqual("2|2|2|One");
  });

  it("paginates multi-tag intersections using filtered totals when path_prefix is set", async function () {
    await this.write({
      path: "/blog/one.txt",
      content: "Title: One\nTags: foo, bar\n\nOne body",
    });
    await this.write({
      path: "/blog/two.txt",
      content: "Title: Two\nTags: foo, bar\n\nTwo body",
    });
    await this.write({
      path: "/notes/three.txt",
      content: "Title: Three\nTags: foo, bar\n\nThree body",
    });

    await this.template(
      {
        "tagged.html": `{{#tagged}}{{total}}|{{pagination.total}}|{{pagination.current}}|{{#entries}}{{title}}{{/entries}}{{/tagged}}`,
      },
      {
        locals: {
          path_prefix: "/blog/",
          tagged_page_size: 1,
        },
      },
    );

    const res = await this.get("/tagged/foo/page/2?tag=foo&tag=bar");
    const body = await res.text();

    expect(res.status).toEqual(200);
    expect(body.trim()).toEqual("2|2|2|One");
  });

  it("reuses tagged entries across requests for the same cacheID", async function () {
    await this.write({
      path: "/first.txt",
      content: "Title: First\nTags: foo\n\nFirst body",
    });
    await this.write({
      path: "/second.txt",
      content: "Title: Second\nTags: foo\n\nSecond body",
    });

    await this.template({
      "tagged.html": `<ul>{{#tagged}}{{#entries}}<li>{{title}}</li>{{/entries}}{{/tagged}}</ul>`,
    });

    const Tags = require("models/tags");
    spyOn(Tags, "get").and.callThrough();

    const first = await this.get("/tagged/foo");
    const firstBody = (await first.text()).trim();
    expect(first.status).toEqual(200);
    expect(firstBody).toEqual("<ul><li>Second</li><li>First</li></ul>");

    const callsAfterFirst = Tags.get.calls.count();
    expect(callsAfterFirst).toBeGreaterThan(0);

    const second = await this.get("/tagged/foo");
    const secondBody = (await second.text()).trim();
    expect(second.status).toEqual(200);
    expect(secondBody).toEqual(firstBody);
    expect(Tags.get.calls.count()).toEqual(callsAfterFirst);
  });
});

describe("tagged cache", function () {
  const Entry = require("models/entry");
  const helperPath = require.resolve("../helpers/fetchTaggedEntries");
  const taggedPath = require.resolve("../tagged");

  function loadTaggedWithStub(taggedStub) {
    delete require.cache[taggedPath];
    delete require.cache[helperPath];
    require.cache[helperPath] = {
      id: helperPath,
      filename: helperPath,
      loaded: true,
      exports: taggedStub,
    };

    return require("../tagged");
  }

  afterEach(function () {
    delete require.cache[taggedPath];
    delete require.cache[helperPath];
  });

  function makeReq(overrides) {
    return Object.assign(
      {
        blog: { id: "blog-1", cacheID: 100 },
        query: { tag: "foo" },
        params: {},
        template: { locals: {} },
        log: function () {},
      },
      overrides
    );
  }

  it("reuses cached responses for identical inputs", function (done) {
    const taggedSpy = jasmine
      .createSpy("fetchTaggedEntries")
      .and.callFake(async function () {
        return {
          entryIDs: ["1", "2"],
          pagination: { page: 1, pages: 1 },
          tag: "foo",
          tagged: { foo: true },
          slugs: ["foo"],
          prettyTags: ["foo"],
          total: 2,
        };
      });

    const tagged = loadTaggedWithStub(taggedSpy);
    tagged._clear();

    spyOn(Entry, "get").and.callFake(function (blogID, entryIDs, callback) {
      callback([
        { id: "1", dateStamp: 1, title: "First" },
        { id: "2", dateStamp: 2, title: "Second" },
      ]);
    });

    tagged(makeReq(), { locals: {} }, function () {
      // A fresh req, with no request-local _taggedFetch, so this second
      // call only hits if the process LRU was populated.
      tagged(makeReq(), { locals: {} }, function () {
        expect(taggedSpy).toHaveBeenCalledTimes(1);
        expect(Entry.get).toHaveBeenCalledTimes(1);
        done();
      });
    });
  });

  it("refetches when cacheID changes", function (done) {
    const taggedSpy = jasmine
      .createSpy("fetchTaggedEntries")
      .and.callFake(async function () {
        return {
          entryIDs: ["1"],
          pagination: {},
          tag: "foo",
          tagged: { foo: true },
          slugs: ["foo"],
          prettyTags: ["foo"],
          total: 1,
        };
      });

    const tagged = loadTaggedWithStub(taggedSpy);
    tagged._clear();

    spyOn(Entry, "get").and.callFake(function (blogID, entryIDs, callback) {
      callback([{ id: "1", dateStamp: 1, title: "First" }]);
    });

    tagged(makeReq({ blog: { id: "blog-1", cacheID: 100 } }), { locals: {} }, function () {
      tagged(makeReq({ blog: { id: "blog-1", cacheID: 101 } }), { locals: {} }, function () {
        expect(taggedSpy).toHaveBeenCalledTimes(2);
        done();
      });
    });
  });

  it("returns isolated copies so caller mutations do not taint cache", function (done) {
    const tagged = loadTaggedWithStub(async function () {
      return {
        entryIDs: ["1"],
        pagination: { page: 1, pages: 3, nested: { total: 10 } },
        tag: "foo",
        tagged: { foo: true },
        slugs: ["foo"],
        prettyTags: ["foo"],
        total: 1,
      };
    });
    tagged._clear();

    spyOn(Entry, "get").and.callFake(function (blogID, entryIDs, callback) {
      callback([{ id: "1", title: "Original" }]);
    });

    tagged(makeReq(), { locals: {} }, function (err, first) {
      expect(err).toBeNull();
      first.entries[0].title = "Mutated";
      first.pagination.nested.total = -1;

      tagged(makeReq(), { locals: {} }, function (secondErr, second) {
        expect(secondErr).toBeNull();
        expect(second.entries[0].title).toBe("Original");
        expect(second.pagination.nested.total).toBe(10);
        done();
      });
    });
  });

  it("varies cache keys across invalidation and query dimensions", function () {
    const tagged = loadTaggedWithStub(function () {});

    const makeKey = function ({
      cacheID,
      tag,
      page,
      limit,
      sortBy,
      order,
      pathPrefix,
    }) {
      return tagged._createCacheKey(
        { blog: { id: "blog-1", cacheID }, query: { tag }, params: {}, template: { locals: {} } },
        {
          tags: tag,
          sortBy,
          order,
          pathPrefix,
          page,
          limit,
        }
      );
    };

    const base = makeKey({
      cacheID: "v1",
      tag: "foo",
      page: 1,
      limit: 10,
      sortBy: "date",
      order: "desc",
      pathPrefix: "/blog/",
    });

    expect(base).not.toBe(
      makeKey({
        cacheID: "v2",
        tag: "foo",
        page: 1,
        limit: 10,
        sortBy: "date",
        order: "desc",
        pathPrefix: "/blog/",
      })
    );
    expect(base).not.toBe(
      makeKey({
        cacheID: "v1",
        tag: "bar",
        page: 1,
        limit: 10,
        sortBy: "date",
        order: "desc",
        pathPrefix: "/blog/",
      })
    );
    expect(base).not.toBe(
      makeKey({
        cacheID: "v1",
        tag: "foo",
        page: 2,
        limit: 10,
        sortBy: "date",
        order: "desc",
        pathPrefix: "/blog/",
      })
    );
    expect(base).not.toBe(
      makeKey({
        cacheID: "v1",
        tag: "foo",
        page: 1,
        limit: 20,
        sortBy: "date",
        order: "desc",
        pathPrefix: "/blog/",
      })
    );
    expect(base).not.toBe(
      makeKey({
        cacheID: "v1",
        tag: "foo",
        page: 1,
        limit: 10,
        sortBy: "id",
        order: "desc",
        pathPrefix: "/blog/",
      })
    );
    expect(base).not.toBe(
      makeKey({
        cacheID: "v1",
        tag: "foo",
        page: 1,
        limit: 10,
        sortBy: "date",
        order: "asc",
        pathPrefix: "/blog/",
      })
    );
    expect(base).not.toBe(
      makeKey({
        cacheID: "v1",
        tag: "foo",
        page: 1,
        limit: 10,
        sortBy: "date",
        order: "desc",
        pathPrefix: "/notes/",
      })
    );
  });

  it("does not collide an unset path_prefix with the literal string \"undefined\"", function () {
    const tagged = loadTaggedWithStub(function () {});

    const makeKey = (pathPrefix) =>
      tagged._createCacheKey(
        { blog: { id: "blog-1", cacheID: "v1" }, query: {}, params: {}, template: { locals: {} } },
        {
          tags: "foo",
          sortBy: "date",
          order: "desc",
          pathPrefix,
          page: 1,
          limit: 100,
        }
      );

    expect(makeKey(undefined)).not.toBe(makeKey("undefined"));
  });

  it("does not confuse a numeric path_prefix (no filter) with the equivalent string (a real filter)", function () {
    const tagged = loadTaggedWithStub(function () {});

    const makeKey = (pathPrefix) =>
      tagged._createCacheKey(
        { blog: { id: "blog-1", cacheID: "v1" }, query: {}, params: {}, template: { locals: {} } },
        {
          tags: "foo",
          sortBy: "date",
          order: "desc",
          pathPrefix,
          page: 1,
          limit: 100,
        }
      );

    // fetchTaggedEntries treats a non-string as "no filter" but normalizes
    // the string "1" into "/1".
    expect(makeKey(1)).not.toBe(makeKey("1"));
  });

  it("keys tagged_page_size separately from page_size when they resolve to different limits", function (done) {
    const taggedSpy = jasmine
      .createSpy("fetchTaggedEntries")
      .and.callFake(async function (blogID, tags, options) {
        return {
          entryIDs: [],
          pagination: { pageSize: options.limit },
          tag: "foo",
          tagged: { foo: true },
          slugs: ["foo"],
          prettyTags: ["foo"],
          total: 0,
        };
      });

    const tagged = loadTaggedWithStub(taggedSpy);
    tagged._clear();

    spyOn(Entry, "get").and.callFake(function (blogID, entryIDs, callback) {
      callback([]);
    });

    tagged(
      makeReq({ template: { locals: { tagged_page_size: 5 } } }),
      { locals: {} },
      function () {
        tagged(
          makeReq({ template: { locals: { page_size: 10 } } }),
          { locals: {} },
          function () {
            expect(taggedSpy).toHaveBeenCalledTimes(2);
            expect(taggedSpy.calls.argsFor(0)[2].limit).toBe(5);
            expect(taggedSpy.calls.argsFor(1)[2].limit).toBe(10);
            done();
          }
        );
      }
    );
  });

  it("does not cache a hydration miss when IDs came back but Entry.get returned none", function (done) {
    const taggedSpy = jasmine
      .createSpy("fetchTaggedEntries")
      .and.callFake(async function () {
        return {
          entryIDs: ["1", "2"],
          pagination: { page: 1, pages: 1 },
          tag: "foo",
          tagged: { foo: true },
          slugs: ["foo"],
          prettyTags: ["foo"],
          total: 2,
        };
      });

    const tagged = loadTaggedWithStub(taggedSpy);
    tagged._clear();

    spyOn(Entry, "get").and.callFake(function (blogID, entryIDs, callback) {
      callback([]);
    });

    tagged(makeReq(), { locals: {} }, function () {
      tagged(makeReq(), { locals: {} }, function () {
        expect(taggedSpy).toHaveBeenCalledTimes(2);
        expect(Entry.get).toHaveBeenCalledTimes(2);
        done();
      });
    });
  });

  it("still caches a genuinely empty tag (no matching entry IDs)", function (done) {
    const taggedSpy = jasmine
      .createSpy("fetchTaggedEntries")
      .and.callFake(async function () {
        return {
          entryIDs: [],
          pagination: { page: 1, pages: 1 },
          tag: "foo",
          tagged: { foo: true },
          slugs: ["foo"],
          prettyTags: ["foo"],
          total: 0,
        };
      });

    const tagged = loadTaggedWithStub(taggedSpy);
    tagged._clear();

    spyOn(Entry, "get").and.callFake(function (blogID, entryIDs, callback) {
      callback([]);
    });

    tagged(makeReq(), { locals: {} }, function () {
      tagged(makeReq(), { locals: {} }, function () {
        expect(taggedSpy).toHaveBeenCalledTimes(1);
        done();
      });
    });
  });

  it("does not reuse a cached multi-tag payload when the tag order differs", function (done) {
    const taggedSpy = jasmine
      .createSpy("fetchTaggedEntries")
      .and.callFake(async function (blogID, tags) {
        const list = Array.isArray(tags) ? tags : [tags];
        return {
          entryIDs: ["1"],
          pagination: {},
          tag: list.join(" + "),
          tagged: { [list.join(" + ")]: true },
          slugs: list,
          prettyTags: list,
          total: 1,
        };
      });

    const tagged = loadTaggedWithStub(taggedSpy);
    tagged._clear();

    spyOn(Entry, "get").and.callFake(function (blogID, entryIDs, callback) {
      callback([{ id: "1", title: "Shared" }]);
    });

    tagged(makeReq({ query: { tag: ["foo", "bar"] } }), { locals: {} }, function (err, first) {
      expect(first.tag).toBe("foo + bar");
      expect(first.prettyTags).toEqual(["foo", "bar"]);

      tagged(makeReq({ query: { tag: ["bar", "foo"] } }), { locals: {} }, function (secondErr, second) {
        expect(second.tag).toBe("bar + foo");
        expect(second.prettyTags).toEqual(["bar", "foo"]);
        expect(taggedSpy).toHaveBeenCalledTimes(2);
        done();
      });
    });
  });
});
