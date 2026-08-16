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
  const entriesModel = require("models/entries");
  const helperPath = require.resolve("../helpers/fetchTaggedEntries");
  const postsPath = require.resolve("../posts");

  function loadPostsWithTaggedStub(taggedStub) {
    delete require.cache[postsPath];
    delete require.cache[helperPath];
    require.cache[helperPath] = {
      id: helperPath,
      filename: helperPath,
      loaded: true,
      exports: taggedStub,
    };

    return require("../posts");
  }

  afterEach(function () {
    delete require.cache[postsPath];
    delete require.cache[helperPath];
  });

  it("reuses cached untagged responses for identical inputs", function (done) {
    const posts = loadPostsWithTaggedStub(function () {});
    posts._clear();

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
    const taggedSpy = jasmine.createSpy("fetchTaggedEntries").and.callFake(function (
      blogID,
      tags,
      options,
      callback
    ) {
      callback(null, { entryIDs: ["1", "2"], pagination: { page: 1, pages: 1 } });
    });

    const posts = loadPostsWithTaggedStub(taggedSpy);
    posts._clear();

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
    const posts = loadPostsWithTaggedStub(function () {});
    posts._clear();

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
    const posts = loadPostsWithTaggedStub(function () {});

    const makeKey = function ({ cacheID, tag, pageNumber, sortBy, order, pathPrefix }) {
      return posts._createCacheKey(
        { blog: { id: "blog-1", cacheID }, query: { tag }, params: {}, template: { locals: {} } },
        { locals: {} },
        {
          branch: tag ? "tagged" : "untagged",
          tags: tag,
          sortBy,
          order,
          pathPrefix,
          pageNumber,
          pageSize: 10,
          limit: 10,
          offset: (pageNumber - 1) * 10,
        }
      );
    };

    const base = makeKey({
      cacheID: "v1",
      tag: "foo",
      pageNumber: 1,
      sortBy: "date",
      order: "desc",
      pathPrefix: "/blog/",
    });

    expect(base).not.toBe(
      makeKey({
        cacheID: "v2",
        tag: "foo",
        pageNumber: 1,
        sortBy: "date",
        order: "desc",
        pathPrefix: "/blog/",
      })
    );
    expect(base).not.toBe(
      makeKey({
        cacheID: "v1",
        tag: "bar",
        pageNumber: 1,
        sortBy: "date",
        order: "desc",
        pathPrefix: "/blog/",
      })
    );
    expect(base).not.toBe(
      makeKey({
        cacheID: "v1",
        tag: "foo",
        pageNumber: 2,
        sortBy: "date",
        order: "desc",
        pathPrefix: "/blog/",
      })
    );
    expect(base).not.toBe(
      makeKey({
        cacheID: "v1",
        tag: "foo",
        pageNumber: 1,
        sortBy: "slug",
        order: "desc",
        pathPrefix: "/blog/",
      })
    );
    expect(base).not.toBe(
      makeKey({
        cacheID: "v1",
        tag: "foo",
        pageNumber: 1,
        sortBy: "date",
        order: "asc",
        pathPrefix: "/blog/",
      })
    );
    expect(base).not.toBe(
      makeKey({
        cacheID: "v1",
        tag: "foo",
        pageNumber: 1,
        sortBy: "date",
        order: "desc",
        pathPrefix: "/notes/",
      })
    );
  });

  it("does not collide tagged and untagged key spaces", function () {
    const posts = loadPostsWithTaggedStub(function () {});

    const tagged = posts._createCacheKey(
      { blog: { id: "blog-1", cacheID: "v1" }, query: { tag: "foo" }, params: {}, template: { locals: {} } },
      { locals: {} },
      {
        branch: "tagged",
        tags: "foo",
        sortBy: "date",
        order: "desc",
        pathPrefix: "/blog/",
        pageNumber: 1,
        pageSize: 10,
        limit: 10,
        offset: 0,
      }
    );

    const untagged = posts._createCacheKey(
      { blog: { id: "blog-1", cacheID: "v1" }, query: {}, params: {}, template: { locals: {} } },
      { locals: {} },
      {
        branch: "untagged",
        tags: "foo",
        sortBy: "date",
        order: "desc",
        pathPrefix: "/blog/",
        pageNumber: 1,
        pageSize: 10,
        limit: 10,
        offset: 0,
      }
    );

    expect(tagged).not.toBe(untagged);
  });
});
