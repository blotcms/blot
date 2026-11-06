const entriesModel = require("models/entries");
const postsRetrieve = require("../render/retrieve/posts");
const cachedTagged = require("models/tags/cachedTagged");
const cachedPage = require("models/entries/cachedPage");

// app/blog/render/retrieve/tests/posts.js already covers the {{#posts}}
// local's pagination, tag filtering, and cache-key/mutation-isolation
// behavior in depth. This file only adds the scenarios that suite doesn't:
// cache invalidation via the real incremental sync path, tagged
// cache-key order, and the tagged/untagged branch split.
describe("posts", function () {
  describe("rendering", function () {
    require("./util/setup")();

    it("does not serve a stale post list after new content is synced", async function () {
      // Use the real incremental sync path (as a live customer publish would),
      // not rebuild - see app/sync/index.js, which bumps blog.cacheID at the
      // end of a sync and is what actually busts the posts cache below.
      await this.write({ path: "/a.txt", content: "Hello, A!" });

      await this.template({
        "entries.html": "{{#posts}}{{{html}}}{{/posts}}",
      });

      const before = await this.text("/");
      expect(before).toContain("Hello, A!");
      expect(before).not.toContain("Hello, B!");

      await this.write({ path: "/b.txt", content: "Hello, B!" });

      const after = await this.text("/");
      expect(after).toContain("Hello, A!");
      expect(after).toContain("Hello, B!");
    });
  });

  describe("caching", function () {
    beforeEach(function () {
      cachedPage._clear();
      cachedTagged._clear();
    });

    function fakeReqRes(overrides = {}) {
      return {
        req: Object.assign(
          {
            blog: { id: "blog-1", cacheID: 111 },
            template: { locals: {} },
            params: {},
            query: {},
            log: () => {},
          },
          overrides.req
        ),
        res: Object.assign({ locals: {} }, overrides.res),
      };
    }

    it("does not fetch a page of entries when a tag is present", function (done) {
      spyOn(entriesModel, "getPage");

      const { req, res } = fakeReqRes({ req: { query: { tag: "design" } } });

      postsRetrieve(req, res, function (err) {
        // No entries with this tag exist, so we expect an empty result
        // rather than an error, and the untagged code path must not run.
        expect(err).toBeNull();
        expect(entriesModel.getPage).not.toHaveBeenCalled();
        done();
      });
    });

    it("keeps tag order in the tagged cache key", function () {
      const query = {
        limit: 100,
        offset: 0,
        pathPrefix: undefined,
        sortBy: undefined,
        order: undefined,
      };

      // tagged builds tag/slugs/prettyTags from the original sequence, so
      // the two orders must not share an entry
      expect(
        cachedTagged._createCacheKey("blog-1", 111, ["a", "b"], query, [])
      ).not.toBe(
        cachedTagged._createCacheKey("blog-1", 111, ["b", "a"], query, [])
      );
    });
  });
});
