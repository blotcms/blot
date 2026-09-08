describe("tags.get", function () {
  const set = require("../set");
  const get = require("../get");

  function saveEntries(blogID, entries, callback) {
    let index = 0;

    function next(err) {
      if (err) return callback(err);
      if (index >= entries.length) return callback();

      const entry = entries[index++];
      set(blogID, entry, next);
    }

    next();
  }

  // Create a test user and blog before each spec
  global.test.blog();

  it("can be invoked without error", function (done) {
    const blogID = this.blog.id;
    const entry = {
      id: "entry1",
      blogID,
      path: "/entry1",
      tags: ["tag1"],
    };

    set(blogID, entry, function (err) {
      if (err) return done.fail(err);

      get(blogID, "tag1", function (err, entryIDs, tag) {
        expect(err).toBeNull();
        expect(entryIDs).toEqual([entry.id]);
        expect(tag).toEqual("tag1");

        done();
      });
    });
  });

  it("returns entries sorted by dateStamp when limited", function (done) {
    const blogID = this.blog.id;
    const entries = [
      {
        id: "entry-a",
        blogID,
        path: "/entry-a",
        tags: ["Tag One"],
        dateStamp: 1000,
      },
      {
        id: "entry-b",
        blogID,
        path: "/entry-b",
        tags: ["Tag One"],
        dateStamp: 3000,
      },
      {
        id: "entry-c",
        blogID,
        path: "/entry-c",
        tags: ["Tag One"],
        dateStamp: 2000,
      },
    ];

    saveEntries(blogID, entries, function (err) {
      if (err) return done.fail(err);

      get(blogID, "Tag One", { limit: 2 }, function (err, entryIDs, tag) {
        if (err) return done.fail(err);

        expect(entryIDs).toEqual(["entry-b", "entry-c"]);
        expect(tag).toEqual("Tag One");

        done();
      });
    });
  });

  it("returns oldest-first when rev is false", function (done) {
    const blogID = this.blog.id;
    const entries = [
      { id: "old", blogID, path: "/old", tags: ["Tag Rev"], dateStamp: 1000 },
      { id: "mid", blogID, path: "/mid", tags: ["Tag Rev"], dateStamp: 2000 },
      { id: "new", blogID, path: "/new", tags: ["Tag Rev"], dateStamp: 3000 },
    ];

    saveEntries(blogID, entries, function (err) {
      if (err) return done.fail(err);

      get(blogID, "Tag Rev", { rev: false, limit: 2 }, function (err, entryIDs) {
        if (err) return done.fail(err);
        expect(entryIDs).toEqual(["old", "mid"]);
        done();
      });
    });
  });

  it("supports offsets for pagination", function (done) {
    const blogID = this.blog.id;
    const entries = [
      {
        id: "entry-d",
        blogID,
        path: "/entry-d",
        tags: ["Tag Two"],
        dateStamp: 1000,
      },
      {
        id: "entry-e",
        blogID,
        path: "/entry-e",
        tags: ["Tag Two"],
        dateStamp: 4000,
      },
      {
        id: "entry-f",
        blogID,
        path: "/entry-f",
        tags: ["Tag Two"],
        dateStamp: 3000,
      },
    ];

    saveEntries(blogID, entries, function (err) {
      if (err) return done.fail(err);

      get(
        blogID,
        "Tag Two",
        { offset: 1, limit: 1 },
        function (err, entryIDs, tag) {
          if (err) return done.fail(err);

          expect(entryIDs).toEqual(["entry-f"]);
          expect(tag).toEqual("Tag Two");

          done();
        }
      );
    });
  });
});
