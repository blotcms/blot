describe("tags.set", function () {
  const set = require("../set");
  const get = require("../get");

  // Create a test user and blog before each spec
  global.test.blog();

  it("can be invoked without error", function (done) {
    const entry = {
      id: "entry1",
      blogID: "blog1",
      path: "/entry1",
      tags: ["tag1"],
    };

    set(this.blog.id, entry, function (err, result) {
      expect(err).toBeFalsy();
      // The entry is now on tag1, which other entries' pages render
      expect(result).toEqual({ changed: true });
      done();
    });
  });

  ["page", "menu"].forEach(function (property) {
    it(
      "does not index a newly created tagged " + property + " entry",
      function (done) {
        const entry = {
          id: property + "-entry",
          blogID: this.blog.id,
          path: "/" + property + "-entry",
          tags: ["automotive"],
        };
        entry[property] = true;

        set(this.blog.id, entry, (err) => {
          if (err) return done.fail(err);

          get(this.blog.id, "automotive").then(({ entryIDs }) => {
            expect(entryIDs).toEqual([]);
            done();
          }, done.fail);
        });
      }
    );
  });

  it("removes tag associations when an existing post becomes a page", function (done) {
    const entry = {
      id: "work-entry",
      blogID: this.blog.id,
      path: "/work/entry",
      tags: ["automotive", "featured"],
      dateStamp: 1,
    };

    set(this.blog.id, entry, (err) => {
      if (err) return done.fail(err);

      entry.page = true;
      set(this.blog.id, entry, (err) => {
        if (err) return done.fail(err);

        (async () => {
          const automotive = await get(this.blog.id, "automotive");
          expect(automotive.entryIDs).toEqual([]);

          const featured = await get(this.blog.id, "featured");
          expect(featured.entryIDs).toEqual([]);
        })().then(done, done.fail);
      });
    });
  });
});
