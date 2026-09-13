describe("all tags", function () {

  require('blog/tests/util/setup')();

  it("lists all tags", async function () {
      
      await this.write({path: '/a.txt', content: 'Tags: abc\n\nFoo'});
      await this.write({path: '/b.txt', content: 'Tags: abc\n\nBar'});
      await this.write({path: '/c.txt', content: 'Tags: def\n\nBaz'});
      await this.write({path: '/d.txt', content: 'Tags: def\n\nQux'});
      await this.write({path: '/e.txt', content: 'Tags: def\n\nQuux'});

      await this.template({
          'entries.html': `<ul>{{#all_tags}}<li>{{tag}}</li>{{/all_tags}}</ul>`
      });

      const res = await this.get('/');
      const body = await res.text();

      expect(res.status).toEqual(200);
      expect(body.trim()).toEqual('<ul><li>abc</li><li>def</li></ul>');
  });

  it("lists all tags with many posts", async function () {
      const tags = Array.from({ length: 100 }, (_, i) => `tag${i}`);
      const tagUsage = {};
  
      for (let i = 0; i < 200; i++) {
          const numTags = (i % 5) + 1; // Deterministically assign the number of tags
          const postTags = i % 2 ? tags.slice(0, numTags) : tags.slice(-numTags);
          for (const tag of postTags) {
              tagUsage[tag] = (tagUsage[tag] || 0) + 1;
          }
          await this.blog.write({ path: `/post${i}.txt`, content: `Tags: ${postTags.join(', ')}\n\nContent ${i}` });
      }
  
      await this.blog.rebuild();
  
      await this.template({
          'entries.html': `<ul>{{#all_tags}}<li>{{tag}} {{entries.length}}</li>{{/all_tags}}</ul>`
      });
  
      const res = await this.get('/');
      const body = await res.text();
  
      expect(res.status).toEqual(200);
      expect(body.trim()).toEqual('<ul><li>tag0 100</li><li>tag1 80</li><li>tag2 60</li><li>tag3 40</li><li>tag4 20</li><li>tag95 20</li><li>tag96 40</li><li>tag97 60</li><li>tag98 80</li><li>tag99 100</li></ul>');
  }, 30000);

  it("respects template locals.path_prefix in all_tags", async function () {
      await this.write({path: '/blog/a.txt', content: 'Tags: abc\n\nA'});
      await this.write({path: '/blog/b.txt', content: 'Tags: abc, def\n\nB'});
      await this.write({path: '/notes/c.txt', content: 'Tags: def\n\nC'});

      // this.template reads locals from package metadata (second argument).
      await this.template({
          'entries.html': `<ul>{{#all_tags}}<li>{{tag}} {{total}} {{entries.length}}</li>{{/all_tags}}</ul>`
      }, {
          locals: { path_prefix: '/blog/' }
      });

      const res = await this.get('/');
      const body = await res.text();

      expect(res.status).toEqual(200);
      expect(body.trim()).toEqual('<ul><li>abc 2 2</li><li>def 1 1</li></ul>');
  });


  it("encodes slugs in all_tags output", async function () {
      await this.write({path: '/a.txt', content: 'Tags: Design/UI\n\nFoo'});

      await this.template({
          'entries.html': `{{#all_tags}}{{slug}}{{/all_tags}}`
      });

      const res = await this.get('/');
      const body = await res.text();

      expect(res.status).toEqual(200);
      expect(body.trim()).toEqual('design%2Fui');
  });

});

describe("all_tags cache", function () {
  const Tags = require("models/tags");
  const allTagsPath = require.resolve("../all_tags");

  function loadAllTags() {
    delete require.cache[allTagsPath];
    return require("../all_tags");
  }

  afterEach(function () {
    delete require.cache[allTagsPath];
  });

  function makeReq(blog) {
    return {
      blog,
      template: { locals: {} },
      log: function () {},
    };
  }

  it("reuses cached tags for identical cacheIDs and path_prefix", function (done) {
    const allTags = loadAllTags();

    spyOn(Tags, "list").and.callFake(function (blogID, options, callback) {
      callback(null, [{ name: "abc", slug: "abc", entries: ["1"] }]);
    });

    const req = makeReq({ id: "blog-1", cacheID: 100 });

    allTags(req, { locals: {} }, function () {
      allTags(req, { locals: {} }, function () {
        expect(Tags.list).toHaveBeenCalledTimes(1);
        done();
      });
    });
  });

  it("refetches when cacheID changes", function (done) {
    const allTags = loadAllTags();

    spyOn(Tags, "list").and.callFake(function (blogID, options, callback) {
      callback(null, [{ name: "abc", slug: "abc", entries: ["1"] }]);
    });

    allTags(makeReq({ id: "blog-1", cacheID: 100 }), { locals: {} }, function () {
      allTags(makeReq({ id: "blog-1", cacheID: 101 }), { locals: {} }, function () {
        expect(Tags.list).toHaveBeenCalledTimes(2);
        done();
      });
    });
  });

  it("keys the cache on path_prefix as well as cacheID", function (done) {
    const allTags = loadAllTags();

    spyOn(Tags, "list").and.callFake(function (blogID, options, callback) {
      callback(null, [{ name: "abc", slug: "abc", entries: ["1"] }]);
    });

    const blog = { id: "blog-1", cacheID: 100 };

    allTags({ ...makeReq(blog), template: { locals: { path_prefix: "/a/" } } }, { locals: {} }, function () {
      allTags({ ...makeReq(blog), template: { locals: { path_prefix: "/b/" } } }, { locals: {} }, function () {
        expect(Tags.list).toHaveBeenCalledTimes(2);
        done();
      });
    });
  });

  it("does not confuse a numeric path_prefix (no filter) with the equivalent string (a real filter)", function (done) {
    const allTags = loadAllTags();

    // models/tags/list.js's normalizePathPrefix treats a non-string as "no
    // filter" but normalizes the string "1" into "/1" - a naive String()
    // cache key would turn both into the same "1" and let one view's tags
    // leak into the other.
    spyOn(Tags, "list").and.callFake(function (blogID, options, callback) {
      callback(null, [{ name: "abc", slug: "abc", entries: ["1"] }]);
    });

    const blog = { id: "blog-1", cacheID: 100 };

    allTags(
      { ...makeReq(blog), template: { locals: { path_prefix: 1 } } },
      { locals: {} },
      function () {
        allTags(
          { ...makeReq(blog), template: { locals: { path_prefix: "1" } } },
          { locals: {} },
          function () {
            expect(Tags.list).toHaveBeenCalledTimes(2);
            expect(Tags.list.calls.argsFor(0)[1].path_prefix).toBe(1);
            expect(Tags.list.calls.argsFor(1)[1].path_prefix).toBe("1");
            done();
          }
        );
      }
    );
  });

  it("returns isolated copies so caller mutations do not taint cache", function (done) {
    const allTags = loadAllTags();

    spyOn(Tags, "list").and.callFake(function (blogID, options, callback) {
      callback(null, [{ name: "abc", slug: "abc", entries: ["1"] }]);
    });

    const req = makeReq({ id: "blog-1", cacheID: 100 });

    allTags(req, { locals: {} }, function (err, firstTags) {
      firstTags[0].tag = "mutated";

      allTags(req, { locals: {} }, function (err, secondTags) {
        expect(secondTags[0].tag).toBe("abc");
        done();
      });
    });
  });

  it("bypasses the cache for preview requests", function (done) {
    const allTags = loadAllTags();

    spyOn(Tags, "list").and.callFake(function (blogID, options, callback) {
      callback(null, [{ name: "abc", slug: "abc", entries: ["1"] }]);
    });

    const req = makeReq({ id: "blog-1", cacheID: 100 });
    req.preview = true;

    allTags(req, { locals: {} }, function () {
      allTags(req, { locals: {} }, function () {
        expect(Tags.list).toHaveBeenCalledTimes(2);
        done();
      });
    });
  });

  it("restores all_tags_total_posts from the cache on a hit", function (done) {
    const allTags = loadAllTags();

    spyOn(Tags, "list").and.callFake(function (blogID, options, callback) {
      callback(null, [
        { name: "abc", slug: "abc", entries: ["1", "2"] },
        { name: "def", slug: "def", entries: ["2"] },
      ]);
    });

    const req = makeReq({ id: "blog-1", cacheID: 100 });

    allTags(req, { locals: {} }, function () {
      const secondRes = { locals: {} };
      allTags(req, secondRes, function () {
        expect(secondRes.locals.all_tags_total_posts).toBe(2);
        done();
      });
    });
  });
});
