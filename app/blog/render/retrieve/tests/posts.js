describe("posts", function () {
  require("blog/tests/util/setup")();

  it("lists posts", async function () {
    await this.write({ path: "/a.txt", content: "Foo" });
    await this.write({ path: "/b.txt", content: "Bar" });
    await this.write({ path: "/c.txt", content: "Baz" });
    await this.write({ path: "/d.txt", content: "Qux" });
    await this.write({ path: "/e.txt", content: "Quux" });

    await this.template(
      {
        "foo.html": `{{#posts}}{{{name}}} {{/posts}}`,
      },
      {
        views: {
          "foo.html": {
            url: ["/foo", "/foo/page/:page"],
          },
        },
        locals: {
          page_size: 3,
        },
      }
    );

    const res = await this.get("/foo");
    const text = await res.text();

    expect(text.trim()).toEqual("e.txt d.txt c.txt");

    const res2 = await this.get("/foo/page/2");
    const text2 = await res2.text();
    expect(text2.trim()).toEqual("b.txt a.txt");
  });

  it("lists the page when entries.html binds only {{#entries}}", async function () {
    await this.write({ path: "/a.txt", content: "Hello, A!" });
    await this.write({ path: "/b.txt", content: "Hello, B!" });

    await this.template({
      "entries.html": "{{#entries}}{{{name}}} {{/entries}}",
    });

    const body = await this.text("/");

    expect(body).toContain("b.txt");
    expect(body).toContain("a.txt");
    expect(body).not.toContain("{{#posts}}");
  });

  it("getPages once when a view binds both {{#entries}} and {{#posts}}", async function () {
    const entriesModel = require("models/entries");
    spyOn(entriesModel, "getPage").and.callThrough();

    await this.write({ path: "/a.txt", content: "Hello, A!" });
    await this.write({ path: "/b.txt", content: "Hello, B!" });

    // Official templates bind {{#posts}}; older/custom ones still bind
    // {{#entries}}. Both names alias the same posts retrieve, so a view
    // referencing both must not cause a second Entries.getPage call.
    await this.template({
      "entries.html":
        "{{#entries}}{{{name}}}-e {{/entries}}{{#posts}}{{{name}}}-p {{/posts}}",
    });

    const body = await this.text("/");

    expect(body).toContain("b.txt-e");
    expect(body).toContain("b.txt-p");
    expect(entriesModel.getPage).toHaveBeenCalledTimes(1);
  });

  it("keeps html on {{#entries}} when {{#posts}} only binds title", async function () {
    await this.write({ path: "/a.txt", content: "Hello, A!" });

    await this.template({
      "entries.html":
        "{{#entries}}{{{html}}}{{/entries}}{{#posts}}{{title}}{{/posts}}",
    });

    const locals = await (await this.get("/?json=1")).json();

    expect(locals.entries[0].html).toContain("Hello, A!");
    expect(locals.posts[0].html).toContain("Hello, A!");
  });

  it("still projects posts on entries.html when the view does not bind {{#entries}}", async function () {
    await this.write({ path: "/a.txt", content: "Hello, A!" });

    await this.template({
      "entries.html": "{{#posts}}{{title}}{{/posts}}",
    });

    const locals = await (await this.get("/?json=1")).json();

    expect(locals.posts[0].title).toBeDefined();
    expect(locals.posts[0].html).toBeUndefined();
    expect(locals.entries[0].html).toBeUndefined();
  });

  it("respects a page_size set on the entries.html view itself, not just the template", async function () {
    await this.write({ path: "/a.txt", content: "Hello, A!" });
    await this.write({ path: "/b.txt", content: "Hello, B!" });
    await this.write({ path: "/c.txt", content: "Hello, C!" });

    // retrieve/posts runs after view locals are merged, so a per-view
    // page_size on entries.html wins over the template default.
    await this.template(
      { "entries.html": "{{#posts}}{{{name}}} {{/posts}}" },
      { views: { "entries.html": { locals: { page_size: 2 } } } }
    );

    const body = await this.text("/");

    expect(body.trim().split(" ").length).toEqual(2);
  });

  it("filters posts by query tag", async function () {
    await this.write({
      path: "/a.txt",
      content: "Title: A\nTags: foo\n\nA",
    });
    await this.write({
      path: "/b.txt",
      content: "Title: B\nTags: bar\n\nB",
    });
    await this.write({
      path: "/c.txt",
      content: "Title: C\nTags: foo\n\nC",
    });

    await this.template(
      {
        "foo.html": `{{#posts}}{{title}} {{/posts}}`,
      },
      {
        views: {
          "foo.html": {
            url: "/",
          },
        },
      }
    );

    const res = await this.get("/?tag=foo");
    const text = await res.text();

    expect(text.trim()).toEqual("C A");
  });

  it("filters posts by res.locals.tag", function (done) {
    const posts = require("blog/render/retrieve/posts");

    this.write({
      path: "/a.txt",
      content: "Title: A\nTags: foo\n\nA",
    })
      .then(() =>
        this.write({
          path: "/b.txt",
          content: "Title: B\nTags: bar\n\nB",
        })
      )
      .then(() => {
        const req = {
          blog: { id: this.blog.id },
          query: {},
          params: {},
          template: { locals: {} },
          log: function () {},
        };

        const res = {
          locals: {
            tag: "foo",
          },
        };

        posts(req, res, function (err, entries) {
          expect(err).toBeNull();
          expect(entries.map((entry) => entry.title)).toEqual(["A"]);
          done();
        });
      })
      .catch(done.fail);
  });

  it("filters posts by tag and path_prefix", async function () {
    await this.write({
      path: "/blog/one.txt",
      content: "Title: One\nTags: foo\n\nOne",
    });
    await this.write({
      path: "/notes/two.txt",
      content: "Title: Two\nTags: foo\n\nTwo",
    });
    await this.write({
      path: "/blog/three.txt",
      content: "Title: Three\nTags: bar\n\nThree",
    });

    await this.template(
      {
        "foo.html": `{{#posts}}{{title}} {{/posts}}`,
      },
      {
        views: {
          "foo.html": {
            url: "/",
          },
        },
        locals: {
          path_prefix: "/blog/",
        },
      }
    );

    const res = await this.get("/?tag=foo");
    const text = await res.text();

    expect(text.trim()).toEqual("One");
  });


  it("augments tags on posts across cached requests", async function () {
    await this.write({
      path: "/paris.txt",
      content: "Title: Paris\nTags: Paris\n\nBonjour",
    });

    await this.template(
      {
        "foo.html": `{{#posts}}{{#tags}}{{name}}|{{slug}}|{{first}}|{{last}}{{/tags}}{{/posts}}`,
      },
      {
        views: {
          "foo.html": {
            url: "/foo",
          },
        },
      }
    );

    const first = await this.get("/foo");
    expect((await first.text()).trim()).toEqual("Paris|paris|true|true");

    const second = await this.get("/foo");
    expect((await second.text()).trim()).toEqual("Paris|paris|true|true");
  });

  it("defaults to 5 posts per page when page_size is unset", async function () {
    for (const letter of ["a", "b", "c", "d", "e", "f"]) {
      await this.write({ path: `/${letter}.txt`, content: letter });
    }

    await this.template(
      {
        "foo.html": `{{#posts}}{{{name}}} {{/posts}}`,
      },
      {
        views: {
          "foo.html": {
            url: "/foo",
          },
        },
      }
    );

    const res = await this.get("/foo");
    const text = (await res.text()).trim();

    // models/entries.getPage defaults to 5 per page when no page_size is
    // configured - this must not be overridden by pagination normalization
    // (which defaults to 100) before reaching the model.
    expect(text.split(" ").length).toEqual(5);
  });

  describe("rejects invalid page numbers", function () {
    const cases = [
      ["zero", "/page/0"],
      ["negative", "/page/-1"],
      ["decimal", "/page/1.5"],
      ["NaN", "/page/NaN"],
      ["Infinity", "/page/Infinity"],
      ["beyond MAX_SAFE_INTEGER", "/page/9007199254740999"],
      ["extreme overflow", "/page/99999999999999999999"],
      ["alphabetic", "/page/abc"],
    ];

    for (const [label, path] of cases) {
      it(`rejects ${label} (${path})`, async function () {
        const res = await this.get(path);
        expect(res.status).toEqual(400);
      });
    }
  });
});

describe("posts cache", function () {
  const Entry = require("models/entry");
  const Tags = require("models/tags");
  const entriesModel = require("models/entries");
  const posts = require("../posts");
  const cachedPage = require("models/entries/cachedPage");
  const cachedTagged = require("models/tags/cachedTagged");
  const { keepFields } = require("models/entries/heavyFields");
  const projectEntryFields = require("../helpers/projectEntryFields");

  beforeEach(function () {
    cachedPage._clear();
    cachedTagged._clear();
  });

  it("forwards raw, unnormalized pageNumber/pageSize to models/entries.getPage", function (done) {
    spyOn(entriesModel, "getPage").and.callFake(function (blogID, options, callback) {
      // models/entries.getPage does its own validation (default page size 5,
      // max 100, and a 400 for a non-digit page). If posts.js pre-normalizes
      // these with lib/pagination (default 100, max 500, never rejects)
      // before calling getPage, that validation is silently bypassed.
      expect(options.pageSize).toBeUndefined();
      expect(options.pageNumber).toBe("not-a-number");
      callback(null, [], { page: 1, pages: 1 });
    });

    posts(
      {
        blog: { id: "blog-1", cacheID: 100 },
        query: { page: "not-a-number" },
        params: {},
        template: { locals: {} },
        log: function () {},
      },
      { locals: {} },
      function (err) {
        expect(err).toBeNull();
        expect(entriesModel.getPage).toHaveBeenCalledTimes(1);
        done();
      }
    );
  });

  it("passes nested sort locals into getPage", function (done) {
    spyOn(entriesModel, "getPage").and.callFake(function (blogID, options, callback) {
      expect(options.sortBy).toBe("id");
      expect(options.order).toBe("desc");
      callback(null, [], { page: 1, pages: 1 });
    });

    posts(
      {
        blog: { id: "blog-1", cacheID: 100 },
        query: {},
        params: {},
        template: { locals: { sort: { by: "id", direction: "desc" } } },
        log: function () {},
      },
      { locals: {} },
      function (err) {
        expect(err).toBeNull();
        expect(entriesModel.getPage).toHaveBeenCalledTimes(1);
        done();
      }
    );
  });

  it("forwards the resolved sort selection to Tags.tagged and orders the page", function (done) {
    let received;
    spyOn(Tags, "tagged").and.callFake(async function (blogID, tags, options) {
      received = { blogID, tags, options };
      return { entryIDs: ["a.txt", "m.txt", "z.txt"], pagination: {} };
    });

    spyOn(Entry, "get").and.callFake(function (blogID, ids, cb) {
      // Entry.get preserves input order; return the hydrated entries shuffled
      // to prove posts.js re-applies the selected order.
      cb([
        { id: "m.txt", dateStamp: 2 },
        { id: "z.txt", dateStamp: 1 },
        { id: "a.txt", dateStamp: 3 },
      ]);
    });

    posts(
      {
        blog: { id: "blog-1", cacheID: 100 },
        query: { tag: "foo" },
        params: {},
        template: { locals: { sort_by: "id", sort_order: "asc" } },
        log: function () {},
      },
      { locals: {} },
      function (err, entries) {
        expect(err).toBeNull();
        expect(received.options.sortBy).toBe("id");
        expect(received.options.order).toBe("asc");
        expect(entries.map((entry) => entry.id)).toEqual([
          "a.txt",
          "m.txt",
          "z.txt",
        ]);
        done();
      }
    );
  });

  it("reuses cached untagged responses for identical inputs", function (done) {
    spyOn(entriesModel, "getPage").and.callFake(function (blogID, options, callback) {
      callback(null, [{ id: "1", title: "A" }], { page: 1, pages: 1 });
    });

    const req = {
      blog: { id: "blog-1", cacheID: 100 },
      query: {},
      params: {},
      template: { locals: { page_size: 5 } },
      log: function () {},
    };

    posts(req, { locals: {} }, function () {
      posts(req, { locals: {} }, function () {
        expect(entriesModel.getPage).toHaveBeenCalledTimes(1);
        done();
      });
    });
  });

  it("reuses cached tagged responses for identical inputs", function (done) {
    const taggedSpy = spyOn(Tags, "tagged").and.callFake(
      async function (blogID, tags, options) {
        return { entryIDs: ["1", "2"], pagination: { page: 1, pages: 1 } };
      }
    );

    spyOn(Entry, "get").and.callFake(function (blogID, entryIDs, callback) {
      callback([
        { id: "1", dateStamp: 1, title: "First" },
        { id: "2", dateStamp: 2, title: "Second" },
      ]);
    });

    const req = {
      blog: { id: "blog-1", cacheID: 100 },
      query: { tag: "foo" },
      params: {},
      template: { locals: { page_size: 2, path_prefix: "/blog/" } },
      log: function () {},
    };

    posts(req, { locals: {} }, function () {
      posts(req, { locals: {} }, function () {
        expect(taggedSpy).toHaveBeenCalledTimes(1);
        expect(Entry.get).toHaveBeenCalledTimes(1);
        done();
      });
    });
  });

  it("returns isolated copies so caller mutations do not taint cache", function (done) {
    spyOn(entriesModel, "getPage").and.callFake(function (blogID, options, callback) {
      callback(null, [{ title: "Original" }], { page: 1, pages: 3, nested: { total: 10 } });
    });

    const req = {
      blog: { id: "blog-1", cacheID: 100 },
      query: {},
      params: {},
      template: { locals: {} },
      log: function () {},
    };

    const firstRes = { locals: {} };

    posts(req, firstRes, function (err, firstEntries) {
      expect(err).toBeNull();
      firstEntries[0].title = "Mutated";
      firstRes.locals.pagination.nested.total = -1;

      const secondRes = { locals: {} };
      posts(req, secondRes, function (secondErr, secondEntries) {
        expect(secondErr).toBeNull();
        expect(secondEntries[0].title).toBe("Original");
        expect(secondRes.locals.pagination.nested.total).toBe(10);
        expect(entriesModel.getPage).toHaveBeenCalledTimes(1);
        done();
      });
    });
  });

  it("varies cache keys across invalidation and query dimensions", function () {
    const makeKey = function ({ cacheID, tag, pageNumber, sortBy, order, pathPrefix }) {
      const query = { pageSize: 10, pageNumber, sortBy, order, pathPrefix };
      return tag
        ? cachedTagged._createCacheKey(
            "blog-1",
            cacheID,
            tag,
            {
              limit: 10,
              offset: (pageNumber - 1) * 10,
              sortBy,
              order,
              pathPrefix,
            },
            []
          )
        : cachedPage._createCacheKey("blog-1", cacheID, query, []);
    };

    for (const tag of ["foo", undefined]) {
      const other = tag ? [{ tag: "bar" }] : [];
      const base = {
        cacheID: "v1",
        tag,
        pageNumber: 1,
        sortBy: "date",
        order: "desc",
        pathPrefix: "/blog/",
      };

      for (const change of [
        { cacheID: "v2" },
        { pageNumber: 2 },
        { sortBy: "slug" },
        { order: "asc" },
        { pathPrefix: "/notes/" },
        ...other,
      ]) {
        expect(makeKey(base)).not.toBe(makeKey({ ...base, ...change }));
      }
    }
  });

  it("does not collide an unset page_size with an explicit default-sized one", function () {
    // The untagged branch keys on the RAW page size - an unset value must
    // not collide with an explicit page_size equal to normalizePageSize's own
    // default (100), or two different requests would share a cache entry
    // fetched with models/entries' unrelated default of 5. See
    // https://github.com/blotcms/blot/issues/1844
    const makeKey = (pageSize) =>
      cachedPage._createCacheKey(
        "blog-1",
        "v1",
        { pageNumber: 1, pageSize, sortBy: "date", order: "desc" },
        []
      );

    expect(makeKey(undefined)).not.toBe(makeKey(100));
  });

  it("does not collide an unset path_prefix with the literal string \"undefined\"", function () {
    const makeKey = (pathPrefix) =>
      cachedPage._createCacheKey(
        "blog-1",
        "v1",
        { pageNumber: 1, pageSize: 100, sortBy: "date", order: "desc", pathPrefix },
        []
      );

    expect(makeKey(undefined)).not.toBe(makeKey("undefined"));
  });

  it("keys on the heavy fields kept, not on how they were listed", function () {
    const query = { pageNumber: 1, pageSize: 5, sortBy: "date", order: "desc" };
    const key = (keep) =>
      cachedPage._createCacheKey("blog-1", "v1", query, keepFields(keep));

    expect(key(["html", "body"])).toBe(key(["body", "html"]));
    expect(key(["html"])).not.toBe(key(undefined));
    expect(key(["html"])).not.toBe(key([]));
  });

  it("keeps every heavy field for an {{#entries}} binding without a fields map", function () {
    expect(
      projectEntryFields.heavyFieldsToKeep(
        { posts: { fields: { title: true } }, entries: true },
        ["posts", "entries"]
      )
    ).toBeUndefined();
  });

  it("drops heavy fields the view does not reference before caching", async function () {
    spyOn(entriesModel, "getPage").and.callFake(function (blogID, options, callback) {
      callback(null, [{ id: "1", title: "A", html: "<p>A</p>", body: "A" }], {});
    });

    const result = await new Promise((resolve, reject) =>
      posts(
        {
          blog: { id: "blog-1", cacheID: 100 },
          query: {},
          params: {},
          template: { locals: {} },
          retrieve: { posts: { fields: { title: true, html: true } } },
          log: function () {},
        },
        { locals: {} },
        (err, entries) => (err ? reject(err) : resolve(entries))
      )
    );

    expect(result).toEqual([{ id: "1", title: "A", html: "<p>A</p>" }]);
  });
});
