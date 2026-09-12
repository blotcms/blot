const redis = require("models/client");
const Entries = require("./index"); // Replace with the correct path to the Entries module
const Entry = require("../entry");
const Blog = require("../blog");
const entryKey = require("../entry/key").entry;

function buildEntry(path, overrides) {
  const now = Date.now();
  const normalizedPath = path.startsWith("/") ? path : "/" + path;
  const id = overrides && overrides.id ? overrides.id : normalizedPath;

  const base = {
    id,
    guid: id + ":guid",
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
    slug: id.replace(/\//g, "-").replace(/\./g, "-"),
    name: normalizedPath.replace(/^\//, ""),
    path: normalizedPath,
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
    dateStamp: now,
    created: now,
    updated: now,
    metadata: {},
    exif: {},
  };

  return Object.assign(base, overrides || {});
}

describe("entries", function () {
  // Cleans up the Redis database after each test
  // and exposes a test blog to each test
  global.test.blog();

  describe("entry TTL management", function () {
    it("sets a TTL when deleted and clears it when restored", async function () {
      const blogID = this.blog.id;
      const path = "/ttl-entry.txt";
      const key = entryKey(blogID, path);

      await new Promise((resolve, reject) => {
        Entry.set(blogID, path, buildEntry(path), (err) => (err ? reject(err) : resolve()));
      });

      const ttl = await redis.ttl(key);
      expect(ttl).toBe(-1);

      await new Promise((resolve, reject) => {
        Entry.set(blogID, path, { deleted: true }, (err) => (err ? reject(err) : resolve()));
      });

      const ttlAfterDelete = await redis.ttl(key);
      expect(ttlAfterDelete).toBeGreaterThan(0);
      expect(ttlAfterDelete).toBeLessThanOrEqual(24 * 60 * 60);

      await new Promise((resolve, reject) => {
        Entry.set(blogID, path, { deleted: false }, (err) => (err ? reject(err) : resolve()));
      });

      const ttlAfterRestore = await redis.ttl(key);
      expect(ttlAfterRestore).toBe(-1);
    });
  });

  describe("scheduled rebuilds", function () {
    it("clears the scheduled flag when the dateStamp is removed", function (done) {
      const blogID = this.blog.id;
      const path = "/scheduled-entry.txt";
      const future = Date.now() + 24 * 60 * 60 * 1000;

      const initialEntry = buildEntry(path, { dateStamp: future });

      Entry.set(blogID, path, initialEntry, function (err) {
        if (err) return done.fail(err);

        Entry.get(blogID, path, function (stored) {
          expect(stored.scheduled).toBe(true);

          const rebuild = Object.assign({}, stored, {
            metadata: {},
            dateStampWasRemoved: true,
          });

          delete rebuild.dateStamp;

          Entry.set(blogID, path, rebuild, function (err) {
            if (err) return done.fail(err);

            Entry.get(blogID, path, function (updated) {
              expect(updated.scheduled).toBe(false);
              expect(updated.dateStamp).toBe(updated.created);
              done();
            });
          });
        });
      });
    });
  });

  describe("entry list membership transitions", function () {
    it("keeps list and lex memberships in sync across state transitions", async function () {
      const blogID = this.blog.id;
      const path = "/stateful-entry.txt";
      const listNames = ["all", "created", "entries", "drafts", "scheduled", "pages", "deleted"];
      const keyFor = (name) => `blog:${blogID}:${name}`;
      const lexKey = `blog:${blogID}:entries:lex`;

      async function getMembership() {
        const membership = {};

        for (const listName of listNames) {
          membership[listName] = await redis.zRange(keyFor(listName), 0, -1);
        }

        membership.lex = await redis.zRange(lexKey, 0, -1);
        return membership;
      }

      async function setEntry(updates) {
        await new Promise((resolve, reject) => {
          Entry.set(blogID, path, updates, (err) => (err ? reject(err) : resolve()));
        });
      }

      await setEntry(buildEntry(path));

      let membership = await getMembership();
      expect(membership.all).toContain(path);
      expect(membership.created).toContain(path);
      expect(membership.entries).toContain(path);
      expect(membership.drafts).not.toContain(path);
      expect(membership.scheduled).not.toContain(path);
      expect(membership.pages).not.toContain(path);
      expect(membership.deleted).not.toContain(path);
      expect(membership.lex).toContain(path);

      await setEntry({ draft: true });

      membership = await getMembership();
      expect(membership.all).toContain(path);
      expect(membership.created).toContain(path);
      expect(membership.entries).not.toContain(path);
      expect(membership.drafts).toContain(path);
      expect(membership.scheduled).not.toContain(path);
      expect(membership.pages).not.toContain(path);
      expect(membership.deleted).not.toContain(path);
      expect(membership.lex).not.toContain(path);

      await setEntry({ draft: false, page: true });

      membership = await getMembership();
      expect(membership.created).toContain(path);
      expect(membership.entries).not.toContain(path);
      expect(membership.drafts).not.toContain(path);
      expect(membership.pages).toContain(path);
      expect(membership.scheduled).not.toContain(path);
      expect(membership.deleted).not.toContain(path);
      expect(membership.lex).not.toContain(path);

      // Scheduling is derived from dateStamp in entry/set.js (entry.scheduled = entry.dateStamp > Date.now()).
      await setEntry({ page: false, dateStamp: Date.now() + 60_000 });

      membership = await getMembership();
      expect(membership.created).toContain(path);
      expect(membership.entries).not.toContain(path);
      expect(membership.pages).not.toContain(path);
      expect(membership.scheduled).toContain(path);
      expect(membership.deleted).not.toContain(path);
      expect(membership.lex).not.toContain(path);

      await setEntry({ dateStamp: Date.now() - 60_000 });

      membership = await getMembership();
      expect(membership.created).toContain(path);
      expect(membership.entries).toContain(path);
      expect(membership.scheduled).not.toContain(path);
      expect(membership.deleted).not.toContain(path);
      expect(membership.lex).toContain(path);

      await setEntry({ deleted: true });

      membership = await getMembership();
      expect(membership.all).toContain(path);
      expect(membership.created).not.toContain(path);
      expect(membership.entries).not.toContain(path);
      expect(membership.drafts).not.toContain(path);
      expect(membership.scheduled).not.toContain(path);
      expect(membership.pages).not.toContain(path);
      expect(membership.deleted).toContain(path);
      expect(membership.lex).not.toContain(path);

      await setEntry({ deleted: false });

      membership = await getMembership();
      expect(membership.all).toContain(path);
      expect(membership.created).toContain(path);
      expect(membership.entries).toContain(path);
      expect(membership.drafts).not.toContain(path);
      expect(membership.scheduled).not.toContain(path);
      expect(membership.pages).not.toContain(path);
      expect(membership.deleted).not.toContain(path);
      expect(membership.lex).toContain(path);
    });
  });

  describe("pruneMissing", function () {
    it("removes all orphaned IDs from entry lists", async function () {
      const blogID = this.blog.id;
      const path = "/prune-entry.txt";
      const ghostIDs = ["/ghost-entry-1", "/ghost-entry-2"];
      const listKey = `blog:${blogID}:entries`;

      await new Promise((resolve, reject) => {
        Entry.set(blogID, path, buildEntry(path), (err) => (err ? reject(err) : resolve()));
      });

      await redis.zAdd(
        listKey,
        ghostIDs.map((ghostID, index) => ({
          score: Date.now() + index,
          value: ghostID,
        }))
      );

      await new Promise((resolve, reject) => {
        Entries.pruneMissing(blogID, (err) => (err ? reject(err) : resolve()));
      });

      const members = await redis.zRange(listKey, 0, -1);
      expect(members).toContain(path);
      ghostIDs.forEach((ghostID) => {
        expect(members).not.toContain(ghostID);
      });
    });
  });

  it("getTotal should return the total number of entries for a blog", async function (done) {
    const key = `blog:${this.blog.id}:entries`;

    // Add mock entries in Redis
    await redis.zAdd(key, [
      { score: 1, value: "entry1" },
      { score: 2, value: "entry2" },
      { score: 3, value: "entry3" },
    ]);

    Entries.getTotal(this.blog.id, function (err, total) {
      expect(err).toBeNull();
      expect(total).toBe(3);
      done();
    });
  });

  it("getTotal should return 0 if no entries exist for a blog", function (done) {
    Entries.getTotal(this.blog.id, function (err, total) {
      expect(err).toBeNull();
      expect(total).toBe(0);
      done();
    });
  });

  it("getAllIDs should return all entry IDs for a blog", async function (done) {
    const key = `blog:${this.blog.id}:all`;

    // Add mock entries in Redis
    await redis.zAdd(key, [
      { score: 1, value: "id1" },
      { score: 2, value: "id2" },
      { score: 3, value: "id3" },
    ]);

    Entries.getAllIDs(this.blog.id, function (err, ids) {
      expect(err).toBeNull();
      expect(ids).toEqual(["id3", "id2", "id1"]); // Returned in descending order
      done();
    });
  });

  it("getAllIDs should return an empty array if no entries exist", function (done) {
    Entries.getAllIDs(this.blog.id, function (err, ids) {
      expect(err).toBeNull();
      expect(ids).toEqual([]);
      done();
    });
  });

  it("getPage should reject invalid page numbers", function (done) {
    const blogID = this.blog.id;
    const pageSize = 2;

    // Test various invalid inputs
    const invalidInputs = [
      null,
      "",
      "abc",
      "-1",
      "0",
      "1.5",
      "1000001", // exceeds MAX_PAGE_NUMBER
      "999999999999999999999", // exceeds safe integer
    ];

    let testsRemaining = invalidInputs.length;

    invalidInputs.forEach((invalidInput) => {
      Entries.getPage(
        blogID,
        { pageNumber: invalidInput, pageSize },
        function (error, entries, pagination) {
          expect(error).not.toBeNull();
          expect(error.statusCode).toBe(400);
          expect(error.message).toBe("Invalid page number");
          expect(error.invalidInput).toBe(invalidInput);
          expect(entries).toBeNull();
          expect(pagination).toBeNull();

          testsRemaining--;
          if (testsRemaining === 0) {
            done();
          }
        }
      );
    });
  });

  it("getPage should return a page of entries sorted by date", async function (done) {
    const key = `blog:${this.blog.id}:entries`;
    const lexKey = `blog:${this.blog.id}:entries:lex`;
    const lexReadyKey = `blog:${this.blog.id}:entries:lex:ready`;
    const now = Date.now();
    const ids = ["/a.txt", "/b.txt", "/c.txt", "/d.txt", "/e.txt", "/f.txt"];
    // Add 6 mock entries in Redis
    await redis.zAdd(key, [
      { score: now, value: ids[0] },
      { score: now + 1000, value: ids[1] },
      { score: now + 2000, value: ids[2] },
      { score: now + 3000, value: ids[3] },
      { score: now + 4000, value: ids[4] },
      { score: now + 5000, value: ids[5] },
    ]);

    const pipeline = redis.multi();
    ids.forEach((id) => pipeline.zAdd(lexKey, { score: 0, value: id }));
    pipeline.set(lexReadyKey, "1");
    await pipeline.exec();

    // spy on the Entry.get function
    // to return the full fake entry
    spyOn(Entry, "get").and.callFake((blogID, ids, callback) => {
      // if array, return an array of fake entries
      if (Array.isArray(ids)) {
        const entries = ids.map((id) => ({ id }));
        return callback(entries);
        // return a single fake entry
      } else {
        return callback({ id: ids });
      }
    });

    const pageNo = 2;
    const pageSize = 2;
    const blogID = this.blog.id;

    // get the second page of entries, 2 per page, sorted by date with newest first
    Entries.getPage(
      blogID,
      {
        pageNumber: pageNo,
        pageSize,
        sortBy: "date",
      },
      function (error, entries, pagination) {
        expect(error).toBeNull();
        expect(entries.map((entry) => entry.id)).toEqual(["/d.txt", "/c.txt"]);
        expect(pagination).toEqual({
          current: 2,
          next: 3,
          previous: 1,
          total: 3, // 6 entries / 2 per page
          pageSize: 2,
          page_size: 2,
          totalEntries: 6,
          total_entries: 6,
        });
        expect(entries.at(-1).pagination).toEqual(pagination);

        // get the first page of entries, 2 per page, sorted reverse alphabetically
        Entries.getPage(
          blogID,
          { pageNumber: 1, pageSize, sortBy: "id", order: "desc" },
          function (error, entries, pagination) {
            expect(error).toBeNull();
            expect(entries.map((entry) => entry.id)).toEqual([
              "/f.txt",
              "/e.txt",
            ]);
            // get the first page of entries, 2 per page, sorted alphabetically
            Entries.getPage(
              blogID,
          { pageNumber: 1, pageSize, sortBy: "id", order: "asc" },
              function (error, entries, pagination) {
                expect(error).toBeNull();
                expect(entries.map((entry) => entry.id)).toEqual([
                  "/a.txt",
                  "/b.txt",
                ]);
                done();
              }
            );
          }
        );
      }
    );
  });

  it("getPage should paginate ID sorting via Redis ranges for asc/desc without full-set fetch", async function (done) {
    const blogID = this.blog.id;
    const key = `blog:${blogID}:entries`;
    const lexKey = `blog:${blogID}:entries:lex`;
    const lexReadyKey = `blog:${blogID}:entries:lex:ready`;
    const now = Date.now();
    const ids = ["/a.txt", "/b.txt", "/c.txt", "/d.txt", "/e.txt", "/f.txt"];

    await redis.zAdd(key, [
      { score: now, value: ids[0] },
      { score: now + 1000, value: ids[1] },
      { score: now + 2000, value: ids[2] },
      { score: now + 3000, value: ids[3] },
      { score: now + 4000, value: ids[4] },
      { score: now + 5000, value: ids[5] },
    ]);

    const pipeline = redis.multi();
    ids.forEach((id) => pipeline.zAdd(lexKey, { score: 0, value: id }));
    pipeline.set(lexReadyKey, "1");
    await pipeline.exec();

    spyOn(Entry, "get").and.callFake((blogID, ids, callback) => {
      if (Array.isArray(ids)) return callback(ids.map((id) => ({ id })));
      return callback({ id: ids });
    });

    const zRangeSpy = spyOn(redis, "zRange").and.callThrough();

    Entries.getPage(
      blogID,
      { pageNumber: 1, pageSize: 2, sortBy: "id", order: "asc" },
      function (error, entries, pagination) {
        expect(error).toBeNull();
        expect(entries.map((entry) => entry.id)).toEqual(["/a.txt", "/b.txt"]);
        expect(pagination.current).toBe(1);

        expect(zRangeSpy).toHaveBeenCalledWith(lexKey, 0, 1);
        expect(zRangeSpy).not.toHaveBeenCalledWith(lexKey, 0, -1);

        Entries.getPage(
          blogID,
          { pageNumber: 2, pageSize: 2, sortBy: "id", order: "asc" },
          function (error, entries) {
            expect(error).toBeNull();
            expect(entries.map((entry) => entry.id)).toEqual(["/c.txt", "/d.txt"]);
            expect(zRangeSpy).toHaveBeenCalledWith(lexKey, 2, 3);

            Entries.getPage(
              blogID,
              { pageNumber: 2, pageSize: 2, sortBy: "id", order: "desc" },
              function (error, entries) {
                expect(error).toBeNull();
                expect(entries.map((entry) => entry.id)).toEqual(["/d.txt", "/c.txt"]);
                expect(zRangeSpy).toHaveBeenCalledWith(lexKey, 2, 3, { REV: true });
                expect(zRangeSpy).not.toHaveBeenCalledWith(lexKey, 0, -1, { REV: true });
                done();
              }
            );
          }
        );
      }
    );
  });

  it("getPage should return object pagination on a single page", async function (done) {
    const key = `blog:${this.blog.id}:entries`;
    const now = Date.now();

    await redis.zAdd(key, { score: now, value: "/only.txt" });

    spyOn(Entry, "get").and.callFake((blogID, ids, callback) => {
      if (Array.isArray(ids)) return callback(ids.map((id) => ({ id })));
      return callback({ id: ids });
    });

    Entries.getPage(
      this.blog.id,
      { pageNumber: 1, pageSize: 10, sortBy: "date" },
      function (error, entries, pagination) {
        expect(error).toBeNull();
        expect(entries.map((entry) => entry.id)).toEqual(["/only.txt"]);
        expect(pagination).toEqual({
          current: 1,
          next: null,
          previous: null,
          total: 1,
          pageSize: 10,
          page_size: 10,
          totalEntries: 1,
          total_entries: 1,
        });
        expect(entries.at(-1).pagination).toEqual(pagination);
        done();
      }
    );
  });

  it("getPage should report total as 1 (not 0) when the blog has no entries", function (done) {
    Entries.getPage(
      this.blog.id,
      { pageNumber: 1, pageSize: 10, sortBy: "date" },
      function (error, entries, pagination) {
        expect(error).toBeNull();
        expect(entries).toEqual([]);
        expect(pagination.current).toBe(1);
        expect(pagination.total).toBe(1);
        done();
      }
    );
  });

  it("getRecent should return the most recent entries with their indices", async function (done) {
    const key = `blog:${this.blog.id}:entries`;

    // Add mock entries in Redis
    await redis.zAdd(key, [
      { score: 1, value: "id1" },
      { score: 2, value: "id2" },
      { score: 3, value: "id3" },
    ]);

    // Mock entries returned by Entry.get
    spyOn(Entry, "get").and.callFake((blogID, ids, callback) => {
      const entries = ids.map((id, index) => ({
        id,
        dateStamp: Date.now() - index * 1000,
      }));
      callback(entries);
    });

    Entries.getRecent(this.blog.id, function (entries) {
      expect(entries.map((entry) => entry.id)).toEqual(["id3", "id2", "id1"]);
      expect(entries[0].index).toBe(3);
      expect(entries[1].index).toBe(2);
      expect(entries[2].index).toBe(1);
      done();
    });
  });

  it("getRecent should return an empty array if there are no entries", function (done) {
    Entries.getRecent(this.blog.id, function (entries) {
      expect(entries).toEqual([]);
      done();
    });
  });





  describe("path index maintenance", function () {
    it("updates lex index for changed entries once index is ready", async function () {
      const blogID = this.blog.id;
      const entriesKey = `blog:${blogID}:entries`;
      const lexKey = `blog:${blogID}:entries:lex`;
      const readyKey = `blog:${blogID}:entries:lex:ready`;
      const now = Date.now();

      await redis.zAdd(entriesKey, { score: now, value: "/Blog/existing.txt" });

      await redis
        .multi()
        .zAdd(lexKey, { score: 0, value: "/Blog/existing.txt" })
        .set(readyKey, "1")
        .exec();

      await new Promise((resolve, reject) => {
        Entry.set(
          blogID,
          "/Blog/new.txt",
          buildEntry("/Blog/new.txt"),
          (err) => (err ? reject(err) : resolve())
        );
      });

      const ids = await redis.zRange(lexKey, 0, -1);
      expect(ids).toContain("/Blog/existing.txt");
      expect(ids).toContain("/Blog/new.txt");

      const ready = await redis.exists(readyKey);
      expect(ready).toBe(1);
    });
  });
  describe("path prefix pagination", function () {
    beforeEach(function () {
      spyOn(Entry, "get").and.callFake((blogID, ids, callback) => {
        if (!Array.isArray(ids)) return callback({ id: ids });
        callback(ids.map((id) => ({ id })));
      });
    });

    async function seedPathPrefixEntries(blogID) {
      const entriesKey = `blog:${blogID}:entries`;
      const now = Date.now();

      await redis.zAdd(entriesKey, [
        { score: now, value: "/Blog/a.txt" },
        { score: now + 1, value: "/Blog/b.txt" },
        { score: now + 2, value: "/Blog/c.txt" },
        { score: now + 3, value: "/Notes/d.txt" },
      ]);

      await redis
        .multi()
        .zAdd(`blog:${blogID}:entries:lex`, { score: 0, value: "/Blog/a.txt" })
        .zAdd(`blog:${blogID}:entries:lex`, { score: 0, value: "/Blog/b.txt" })
        .zAdd(`blog:${blogID}:entries:lex`, { score: 0, value: "/Blog/c.txt" })
        .zAdd(`blog:${blogID}:entries:lex`, { score: 0, value: "/Notes/d.txt" })
        .set(`blog:${blogID}:entries:lex:ready`, "1")
        .exec();
    }

    it("filters posts by path prefix and paginates by id", async function (done) {
      const blogID = this.blog.id;
      await seedPathPrefixEntries(blogID);

      Entries.getPage(
        blogID,
        { pageNumber: 1, pageSize: 2, sortBy: "id", order: "asc", pathPrefix: "/Blog/" },
        function (error, entries, pagination) {
          expect(error).toBeNull();
          expect(entries.map((entry) => entry.id)).toEqual(["/Blog/a.txt", "/Blog/b.txt"]);
          expect(pagination).toEqual({
            current: 1,
            next: 2,
            previous: null,
            total: 2,
            pageSize: 2,
            page_size: 2,
            totalEntries: 3,
            total_entries: 3,
          });
          expect(entries.at(-1).pagination).toEqual(pagination);
          done();
        }
      );
    });

    it("normalizes pathPrefix values missing a leading slash", async function (done) {
      const blogID = this.blog.id;
      await seedPathPrefixEntries(blogID);

      Entries.getPage(
        blogID,
        { pageNumber: 1, pageSize: 2, sortBy: "id", order: "asc", pathPrefix: "Blog/" },
        function (error, entries) {
          expect(error).toBeNull();
          expect(entries.map((entry) => entry.id)).toEqual(["/Blog/a.txt", "/Blog/b.txt"]);
          done();
        }
      );
    });



    it("applies Redis-compatible tie ordering for equal date scores under pathPrefix", async function (done) {
      const blogID = this.blog.id;
      const entriesKey = `blog:${blogID}:entries`;
      const lexKey = `blog:${blogID}:entries:lex`;
      const tieScore = Date.now();
      const tieIDs = ["/Blog/a.txt", "/Blog/m.txt", "/Blog/z.txt"];

      await redis.zAdd(entriesKey, [
        { score: tieScore, value: tieIDs[0] },
        { score: tieScore, value: tieIDs[1] },
        { score: tieScore, value: tieIDs[2] },
      ]);

      await redis
        .multi()
        .zAdd(lexKey, { score: 0, value: tieIDs[0] })
        .zAdd(lexKey, { score: 0, value: tieIDs[1] })
        .zAdd(lexKey, { score: 0, value: tieIDs[2] })
        .set(`blog:${blogID}:entries:lex:ready`, "1")
        .exec();

      const taggedSetKey = `blog:${blogID}:tags:sorted:redis-tie-check`;

      await redis.del(taggedSetKey);
      await redis.zAdd(taggedSetKey, [
        { score: tieScore, value: tieIDs[0] },
        { score: tieScore, value: tieIDs[1] },
        { score: tieScore, value: tieIDs[2] },
      ]);

      const expectedAsc = await redis.zRange(taggedSetKey, 0, -1, { REV: true });
      const expectedDesc = await redis.zRange(taggedSetKey, 0, -1);

          Entries.getPage(
            blogID,
            { pageNumber: 1, pageSize: 10, sortBy: "date", order: "asc", pathPrefix: "/Blog/" },
            function (error, ascEntries) {
              expect(error).toBeNull();
              expect(ascEntries.map((entry) => entry.id)).toEqual(expectedAsc);

              Entries.getPage(
                blogID,
                { pageNumber: 1, pageSize: 10, sortBy: "date", order: "desc", pathPrefix: "/Blog/" },
                function (error, descEntries) {
                  expect(error).toBeNull();
                  expect(descEntries.map((entry) => entry.id)).toEqual(expectedDesc);
                  done();
                }
              );
            }
          );
    });
    it("ignores empty or whitespace pathPrefix values", async function (done) {
      const blogID = this.blog.id;
      await seedPathPrefixEntries(blogID);

      Entries.getPage(
        blogID,
        { pageNumber: 1, pageSize: 4, sortBy: "id", order: "asc", pathPrefix: "   " },
        function (error, entries) {
          expect(error).toBeNull();
          expect(entries.map((entry) => entry.id)).toEqual([
            "/Blog/a.txt",
            "/Blog/b.txt",
            "/Blog/c.txt",
            "/Notes/d.txt",
          ]);
          done();
        }
      );
    });
  });
  describe("adjacentTo", function () {
    beforeEach(function () {
      spyOn(Entry, "get").and.callFake((blogID, ids, callback) => {
        const entries = ids.map((id) => ({ id }));
        callback(entries);
      });
    });

    it("should return adjacent entries correctly", async function (done) {
      const key = `blog:${this.blog.id}:entries`;

      // Add mock entries in Redis
      await redis.zAdd(key, [
        { score: 1, value: "id1" },
        { score: 2, value: "id2" },
        { score: 3, value: "id3" },
      ]);

      Entries.adjacentTo(this.blog.id, "id2", function (next, previous, rank) {
        expect(previous).toEqual({ id: "id1" });
        expect(next).toEqual({ id: "id3" });
        expect(rank).toBe(2);
        done();
      });
    });

    it("should return undefined if the entry is at the start of the list", async function (done) {
      const key = `blog:${this.blog.id}:entries`;

      // Add mock entries in Redis
      await redis.zAdd(key, [
        { score: 1, value: "id1" },
        { score: 2, value: "id2" },
        { score: 3, value: "id3" },
      ]);

      Entries.adjacentTo(this.blog.id, "id1", function (next, previous, rank) {
        expect(previous).toBeUndefined();
        expect(next).toEqual({ id: "id2" });
        expect(rank).toBe(1);
        done();
      });
    });

    it("should return undefined if the entry is at the end of the list", async function (done) {
      const key = `blog:${this.blog.id}:entries`;

      // Add mock entries in Redis
      await redis.zAdd(key, [
        { score: 1, value: "id1" },
        { score: 2, value: "id2" },
        { score: 3, value: "id3" },
      ]);

      Entries.adjacentTo(this.blog.id, "id3", function (next, previous, rank) {
        expect(previous).toEqual({ id: "id2" });
        expect(next).toBeUndefined();
        expect(rank).toBe(3);
        done();
      });
    });
  });

  describe("random", function () {
    it("returns undefined when there are no published entries", function (done) {
      spyOn(redis, "zRandMember").and.returnValue(Promise.resolve(null));

      Entries.random(this.blog.id, (entry) => {
        try {
          expect(entry).toBeUndefined();
          done();
        } catch (err) {
          done.fail(err);
        } finally {
          // no-op
        }
      });
    });

    it("retries until an entry with a public URL is found", function (done) {
      const candidates = ["missing", "valid"];

      spyOn(redis, "zRandMember").and.callFake(async function () {
        return candidates.shift();
      });

      spyOn(Entry, "get").and.callFake(function (blogID, entryID, callback) {
        if (entryID === "missing") return callback({ id: entryID });

        callback({ id: entryID, url: "/valid" });
      });

      Entries.random(this.blog.id, function (entry) {
        try {
          expect(entry).toEqual(
            jasmine.objectContaining({ id: "valid", url: "/valid" })
          );
          expect(redis.zRandMember.calls.count()).toBe(2);
          expect(Entry.get.calls.count()).toBe(2);
          done();
        } catch (err) {
          done.fail(err);
        }
      });
    });

    it("stops after the maximum attempts when entries have no public URL", function (done) {
      let calls = 0;

      spyOn(redis, "zRandMember").and.returnValue(Promise.resolve("missing"));

      spyOn(Entry, "get").and.callFake(function (blogID, entryID, callback) {
        calls++;
        callback({ id: entryID });
      });

      Entries.random(this.blog.id, function (entry) {
        try {
          expect(entry).toBeUndefined();
          expect(calls).toBe(Entries.random.MAX_ATTEMPTS);
          done();
        } catch (err) {
          done.fail(err);
        }
      });
    });

    it("handles Redis failures without unhandled rejections", function (done) {
      spyOn(redis, "zRandMember").and.returnValue(
        Promise.reject(new Error("boom"))
      );

      Entries.random(this.blog.id, function (entry) {
        try {
          expect(entry).toBeUndefined();
          done();
        } catch (err) {
          done.fail(err);
        }
      });
    });
  });

  describe("resave", function () {
    it("should update entries with new dateStamps", async function (done) {
      const blog = { id: this.blog.id, permalink: true };
      const entries = [
        { path: "entry1", metadata: {}, id: "id1", metadata: {} },
        { path: "entry2", metadata: {}, id: "id2", metadata: {} },
      ];

      // Mock Blog.get
      spyOn(Blog, "get").and.callFake((query, callback) => {
        callback(null, blog);
      });

      // Add mock entries in Redis
      const key = `blog:${this.blog.id}:all`;
      await redis.zAdd(key, [
        { score: 1, value: "id1" },
        { score: 2, value: "id2" },
      ]);

      // Mock Entry.get to return the entries
      spyOn(Entry, "get").and.callFake((blogID, id, callback) => {
        const result = entries.find((entry) => entry.id === id);
        callback(result);
      });

      // Mock Entry.set
      spyOn(Entry, "set").and.callFake((blogID, path, changes, callback) => {
        expect(changes).toEqual(jasmine.any(Object));
        callback();
      });

      Entries.resave(this.blog.id, function (err) {
        expect(err).toBeNull();
        expect(Entry.set).toHaveBeenCalledTimes(2); // Once per entry
        done();
      });
    });

    it("should handle errors when fetching the blog", function (done) {
      // Mock Blog.get
      spyOn(Blog, "get").and.callFake((query, callback) => {
        callback(new Error("Blog not found"));
      });

      Entries.resave(this.blog.id, function (err) {
        expect(err).toEqual(jasmine.any(Error));
        expect(err.message).toBe("Blog not found");
        done();
      });
    });
  });

  describe("getAll with a limit", function () {
    it("returns only the N most recently published entries", async function (done) {
      const blogID = this.blog.id;
      const key = `blog:${blogID}:entries`;

      await redis.zAdd(key, [
        { score: 1, value: "id1" },
        { score: 2, value: "id2" },
        { score: 3, value: "id3" },
      ]);

      spyOn(Entry, "get").and.callFake((blogID, ids, callback) => {
        callback(ids.map((id) => buildEntry(id, { id })));
      });

      Entries.getAll(blogID, { limit: 2 }, function (entries) {
        expect(entries.map((entry) => entry.id)).toEqual(["id3", "id2"]);
        done();
      });
    });

    it("returns every entry when no limit is given", async function (done) {
      const blogID = this.blog.id;
      const key = `blog:${blogID}:entries`;

      await redis.zAdd(key, [
        { score: 1, value: "id1" },
        { score: 2, value: "id2" },
        { score: 3, value: "id3" },
      ]);

      spyOn(Entry, "get").and.callFake((blogID, ids, callback) => {
        callback(ids.map((id) => buildEntry(id, { id })));
      });

      Entries.getAll(blogID, function (entries) {
        expect(entries.map((entry) => entry.id)).toEqual([
          "id3",
          "id2",
          "id1",
        ]);
        done();
      });
    });
  });
});
