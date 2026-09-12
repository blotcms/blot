const client = require("models/client");
const Entry = require("models/entry");
const Entries = require("models/entries");
const key = require("../key");
const list = require("../list");
const rebuild = require("../rebuild");

function buildEntry(path, dateStamp) {
  return {
    id: path,
    guid: path + ":guid",
    url: "",
    permalink: "",
    title: "Test entry",
    titleTag: "<h1>Test entry</h1>",
    body: "<p>Body</p>",
    summary: "Body",
    teaser: "Body",
    teaserBody: "<p>Body</p>",
    more: false,
    html: "<h1>Test entry</h1><p>Body</p>",
    slug: path.replace(/\//g, "-").replace(/\./g, "-"),
    name: path.replace(/^\//, ""),
    path: path,
    size: 0,
    tags: [],
    dependencies: [],
    backlinks: [],
    internalLinks: [],
    menu: false,
    page: false,
    deleted: false,
    draft: false,
    scheduled: false,
    thumbnail: {},
    dateStamp: dateStamp,
    created: dateStamp,
    updated: dateStamp,
    metadata: {},
    exif: {},
  };
}

describe("archives.rebuild", function () {
  global.test.blog();

  it("groups entries by month and sets the ready flag", function (done) {
    const blogID = this.blog.id;

    const entries = [
      buildEntry("/a.txt", Date.parse("2020-01-05T00:00:00Z")),
      buildEntry("/b.txt", Date.parse("2020-01-25T00:00:00Z")),
      buildEntry("/c.txt", Date.parse("2020-03-01T00:00:00Z")),
    ];

    require("async").eachSeries(
      entries,
      function (entry, next) {
        Entry.set(blogID, entry.path, entry, next);
      },
      async function (err) {
        if (err) return done.fail(err);

        // Simulate a stale/never-built index: wipe the ready flag and leave
        // a bogus month around that no longer has any real entries.
        await client.del(key.ready(blogID));
        await client.zAdd(key.months(blogID), {
          score: 199901,
          value: "1999-01",
        });
        await client.zAdd(key.bucket(blogID, "1999-01"), {
          score: 0,
          value: "ghost",
        });

        rebuild(blogID, async function (err, count) {
          if (err) return done.fail(err);

          expect(count).toBe(3);

          const isReady = await list.isReady(blogID);
          expect(isReady).toBe(true);

          const months = await list.months(blogID);
          expect(months).toEqual([
            { yearMonth: "2020-03", count: 1 },
            { yearMonth: "2020-01", count: 2 },
          ]);

          const stale = await list.bucket(blogID, "1999-01");
          expect(stale).toEqual([]);

          const january = await list.bucket(blogID, "2020-01");
          expect(january).toEqual(["/b.txt", "/a.txt"]);

          done();
        });
      }
    );
  });

  it("is safe to call for a blog with no entries", function (done) {
    rebuild(this.blog.id, function (err, count) {
      if (err) return done.fail(err);
      expect(count).toBe(0);
      done();
    });
  });

  it("aborts without touching the index when the entries fetch comes back empty for a non-empty blog", function (done) {
    const blogID = this.blog.id;
    const entry = buildEntry("/a.txt", Date.parse("2020-01-05T00:00:00Z"));

    Entry.set(blogID, entry.path, entry, function (err) {
      if (err) return done.fail(err);

      rebuild(blogID, async function (err, count) {
        if (err) return done.fail(err);
        expect(count).toBe(1);

        // Simulate Entries.getAll swallowing a Redis read failure - it has
        // no error channel, so a failed read and a genuinely empty blog
        // both resolve to []. The "entries" list itself still has 1 member.
        spyOn(Entries, "getAll").and.callFake(function (blogID, options, cb) {
          cb([]);
        });

        rebuild(blogID, async function (err, count) {
          expect(err).toEqual(jasmine.any(Error));
          expect(count).toBeUndefined();

          // The good index from the first rebuild must survive untouched.
          const months = await list.months(blogID);
          expect(months).toEqual([{ yearMonth: "2020-01", count: 1 }]);

          done();
        });
      });
    });
  });

  it("retries from a fresh snapshot if an entry is saved during the rebuild", function (done) {
    const blogID = this.blog.id;
    const first = buildEntry("/a.txt", Date.parse("2020-01-05T00:00:00Z"));

    Entry.set(blogID, first.path, first, function (err) {
      if (err) return done.fail(err);

      let calls = 0;
      const realGetAll = Entries.getAll.bind(Entries);

      spyOn(Entries, "getAll").and.callFake(function (blogID, options, cb) {
        calls++;

        if (calls === 1) {
          // A second entry is saved (bumping the generation counter -
          // see models/archives/set.js) after this snapshot is taken but
          // before rebuild's transaction executes.
          const second = buildEntry(
            "/b.txt",
            Date.parse("2020-02-05T00:00:00Z")
          );
          return Entry.set(blogID, second.path, second, function (err) {
            if (err) return done.fail(err);
            realGetAll(blogID, options, cb);
          });
        }

        return realGetAll(blogID, options, cb);
      });

      rebuild(blogID, async function (err, count) {
        if (err) return done.fail(err);

        expect(calls).toBeGreaterThan(1);
        expect(count).toBe(2);

        const months = await list.months(blogID);
        expect(months).toEqual([
          { yearMonth: "2020-02", count: 1 },
          { yearMonth: "2020-01", count: 1 },
        ]);

        done();
      });
    });
  });
});
