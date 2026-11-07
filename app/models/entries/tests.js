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

      await Entry.set(blogID, path, buildEntry(path));

      const ttl = await redis.ttl(key);
      expect(ttl).toBe(-1);

      await Entry.set(blogID, path, { deleted: true });

      const ttlAfterDelete = await redis.ttl(key);
      expect(ttlAfterDelete).toBeGreaterThan(0);
      expect(ttlAfterDelete).toBeLessThanOrEqual(24 * 60 * 60);

      await Entry.set(blogID, path, { deleted: false });

      const ttlAfterRestore = await redis.ttl(key);
      expect(ttlAfterRestore).toBe(-1);
    });
  });

  describe("scheduled rebuilds", function () {
    it("clears the scheduled flag when the dateStamp is removed", async function () {
      const blogID = this.blog.id;
      const path = "/scheduled-entry.txt";
      const future = Date.now() + 24 * 60 * 60 * 1000;

      const initialEntry = buildEntry(path, { dateStamp: future });

      await Entry.set(blogID, path, initialEntry);

      const stored = await Entry.get(blogID, path);
      expect(stored.scheduled).toBe(true);

      const rebuild = Object.assign({}, stored, {
        metadata: {},
        dateStampWasRemoved: true,
      });

      delete rebuild.dateStamp;

      await Entry.set(blogID, path, rebuild);

      const updated = await Entry.get(blogID, path);
      expect(updated.scheduled).toBe(false);
      expect(updated.dateStamp).toBe(updated.created);
    });
  });

  describe("entry list membership transitions", function () {
    it("keeps list and lex memberships in sync across state transitions", async function () {
      const blogID = this.blog.id;
      const path = "/stateful-entry.txt";
      const listNames = [
        "all",
        "created",
        "entries",
        "drafts",
        "scheduled",
        "pages",
        "deleted",
      ];
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
        await Entry.set(blogID, path, updates);
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

  describe("sweepExpiredDeleted", function () {
    const DAY = 24 * 60 * 60 * 1000;

    function setEntry(blogID, path, updates) {
      return Entry.set(blogID, path, updates).then(() => {});
    }

    function sweep(blogID) {
      return new Promise((resolve, reject) => {
        Entries.sweepExpiredDeleted(blogID, (err, removed) =>
          err ? reject(err) : resolve(removed)
        );
      });
    }

    // What Redis leaves behind once a deleted entry's TTL runs out: the key
    // is gone and its "deleted" score is more than a day old.
    async function expire(blogID, path) {
      await redis.del(entryKey(blogID, path));
      await redis.zAdd(`blog:${blogID}:deleted`, {
        score: Date.now() - DAY - 60 * 1000,
        value: path,
      });
    }

    async function members(blogID, list) {
      return redis.zRange(`blog:${blogID}:${list}`, 0, -1);
    }

    it("removes expired deleted entries from 'all' and 'deleted' only", async function () {
      const blogID = this.blog.id;

      await setEntry(blogID, "/live.txt", buildEntry("/live.txt"));
      await setEntry(blogID, "/expired.txt", buildEntry("/expired.txt"));
      await setEntry(blogID, "/expired.txt", { deleted: true });
      await setEntry(blogID, "/recent.txt", buildEntry("/recent.txt"));
      await setEntry(blogID, "/recent.txt", { deleted: true });
      await expire(blogID, "/expired.txt");

      expect(await sweep(blogID)).toEqual(["/expired.txt"]);

      expect((await members(blogID, "all")).sort()).toEqual([
        "/live.txt",
        "/recent.txt",
      ]);
      expect(await members(blogID, "deleted")).toEqual(["/recent.txt"]);
      expect(await sweep(blogID)).toEqual([]);
    });

    it("keeps an old 'deleted' member whose entry key still exists", async function () {
      const blogID = this.blog.id;

      await setEntry(blogID, "/kept.txt", buildEntry("/kept.txt"));
      await setEntry(blogID, "/kept.txt", { deleted: true });
      await redis.zAdd(`blog:${blogID}:deleted`, {
        score: Date.now() - 2 * DAY,
        value: "/kept.txt",
      });

      expect(await sweep(blogID)).toEqual([]);
      expect(await members(blogID, "all")).toContain("/kept.txt");
      expect(await members(blogID, "deleted")).toContain("/kept.txt");
    });

    it("sweeps past more than one batch of expired entries", async function () {
      const blogID = this.blog.id;
      const paths = [];

      for (let i = 0; i < 150; i++) paths.push(`/expired-${i}.txt`);

      // An old member whose key still exists sorts first, so every batch
      // has to step past it. Saved before the expired ids are added, since
      // saving an entry runs the sweep itself.
      await setEntry(blogID, "/kept.txt", buildEntry("/kept.txt"));
      await setEntry(blogID, "/kept.txt", { deleted: true });
      await redis.zAdd(`blog:${blogID}:deleted`, {
        score: Date.now() - 3 * DAY,
        value: "/kept.txt",
      });

      await redis.zAdd(
        `blog:${blogID}:all`,
        paths.map((value, i) => ({ score: i, value }))
      );
      await redis.zAdd(
        `blog:${blogID}:deleted`,
        paths.map((value, i) => ({ score: Date.now() - 2 * DAY + i, value }))
      );

      expect((await sweep(blogID)).length).toBe(150);
      expect(await members(blogID, "all")).toEqual(["/kept.txt"]);
      expect(await members(blogID, "deleted")).toEqual(["/kept.txt"]);
    });

    it("runs whenever another entry on the blog is saved", async function () {
      const blogID = this.blog.id;

      await setEntry(blogID, "/expired.txt", buildEntry("/expired.txt"));
      await setEntry(blogID, "/expired.txt", { deleted: true });
      await expire(blogID, "/expired.txt");

      await setEntry(blogID, "/other.txt", buildEntry("/other.txt"));

      expect(await members(blogID, "all")).toEqual(["/other.txt"]);
      expect(await members(blogID, "deleted")).toEqual([]);
    });
  });

  describe("pruneMissing", function () {
    it("removes all orphaned IDs from entry lists", async function () {
      const blogID = this.blog.id;
      const path = "/prune-entry.txt";
      const ghostIDs = ["/ghost-entry-1", "/ghost-entry-2"];
      const listKey = `blog:${blogID}:entries`;

      await Entry.set(blogID, path, buildEntry(path));

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

  it("getTotal should return the total number of entries for a blog", async function () {
    const key = `blog:${this.blog.id}:entries`;

    // Add mock entries in Redis
    await redis.zAdd(key, [
      { score: 1, value: "entry1" },
      { score: 2, value: "entry2" },
      { score: 3, value: "entry3" },
    ]);

    expect(await Entries.getTotal(this.blog.id)).toBe(3);
  });

  it("getTotal should return 0 if no entries exist for a blog", async function () {
    expect(await Entries.getTotal(this.blog.id)).toBe(0);
  });

  it("getAllIDs should return all entry IDs for a blog", async function () {
    const key = `blog:${this.blog.id}:all`;

    // Add mock entries in Redis
    await redis.zAdd(key, [
      { score: 1, value: "id1" },
      { score: 2, value: "id2" },
      { score: 3, value: "id3" },
    ]);

    // Returned in descending order
    expect(await Entries.getAllIDs(this.blog.id)).toEqual([
      "id3",
      "id2",
      "id1",
    ]);
  });

  it("getAllIDs should return an empty array if no entries exist", async function () {
    expect(await Entries.getAllIDs(this.blog.id)).toEqual([]);
  });

  it("getPage should reject invalid page numbers", async function () {
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

    for (const invalidInput of invalidInputs) {
      let error;

      try {
        await Entries.getPage(blogID, { pageNumber: invalidInput, pageSize });
      } catch (e) {
        error = e;
      }

      expect(error).toBeDefined();
      expect(error.statusCode).toBe(400);
      expect(error.message).toBe("Invalid page number");
      expect(error.invalidInput).toBe(invalidInput);
    }
  });

  it("getPage should return a page of entries sorted by date", async function () {
    const key = `blog:${this.blog.id}:entries`;
    const lexKey = `blog:${this.blog.id}:entries:lex`;
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
    await pipeline.exec();

    // spy on the Entry.get function
    // to return the full fake entry
    spyOn(Entry, "get").and.callFake((blogID, ids) => {
      // if array, return an array of fake entries
      if (Array.isArray(ids)) {
        const entries = ids.map((id) => ({ id }));
        return Promise.resolve(entries);
        // return a single fake entry
      } else {
        return Promise.resolve({ id: ids });
      }
    });

    const pageNo = 2;
    const pageSize = 2;
    const blogID = this.blog.id;

    // get the second page of entries, 2 per page, sorted by date with newest first
    const { entries, pagination } = await Entries.getPage(blogID, {
      pageNumber: pageNo,
      pageSize,
      sortBy: "date",
    });

    expect(entries.map((entry) => entry.id)).toEqual(["/d.txt", "/c.txt"]);
    expect(pagination).toEqual({
      current: 2,
      next: 3,
      previous: 1,
      total: 3, // 6 entries / 2 per page
      page_size: 2,
      total_entries: 6,
    });
    expect(entries.at(-1).pagination).toEqual(pagination);

    // get the first page of entries, 2 per page, sorted reverse alphabetically
    const desc = await Entries.getPage(blogID, {
      pageNumber: 1,
      pageSize,
      sortBy: "id",
      order: "desc",
    });
    expect(desc.entries.map((entry) => entry.id)).toEqual(["/f.txt", "/e.txt"]);

    // get the first page of entries, 2 per page, sorted alphabetically
    const asc = await Entries.getPage(blogID, {
      pageNumber: 1,
      pageSize,
      sortBy: "id",
      order: "asc",
    });
    expect(asc.entries.map((entry) => entry.id)).toEqual(["/a.txt", "/b.txt"]);
  });

  it("getPage should paginate ID sorting via Redis ranges for asc/desc without full-set fetch", async function () {
    const blogID = this.blog.id;
    const key = `blog:${blogID}:entries`;
    const lexKey = `blog:${blogID}:entries:lex`;
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
    await pipeline.exec();

    spyOn(Entry, "get").and.callFake((blogID, ids) => {
      if (Array.isArray(ids)) return Promise.resolve(ids.map((id) => ({ id })));
      return Promise.resolve({ id: ids });
    });

    const zRangeSpy = spyOn(redis, "zRange").and.callThrough();

    const first = await Entries.getPage(blogID, {
      pageNumber: 1,
      pageSize: 2,
      sortBy: "id",
      order: "asc",
    });
    expect(first.entries.map((entry) => entry.id)).toEqual([
      "/a.txt",
      "/b.txt",
    ]);
    expect(first.pagination.current).toBe(1);

    expect(zRangeSpy).toHaveBeenCalledWith(lexKey, 0, 1);
    expect(zRangeSpy).not.toHaveBeenCalledWith(lexKey, 0, -1);

    const second = await Entries.getPage(blogID, {
      pageNumber: 2,
      pageSize: 2,
      sortBy: "id",
      order: "asc",
    });
    expect(second.entries.map((entry) => entry.id)).toEqual([
      "/c.txt",
      "/d.txt",
    ]);
    expect(zRangeSpy).toHaveBeenCalledWith(lexKey, 2, 3);

    const desc = await Entries.getPage(blogID, {
      pageNumber: 2,
      pageSize: 2,
      sortBy: "id",
      order: "desc",
    });
    expect(desc.entries.map((entry) => entry.id)).toEqual(["/d.txt", "/c.txt"]);
    expect(zRangeSpy).toHaveBeenCalledWith(lexKey, 2, 3, {
      REV: true,
    });
    expect(zRangeSpy).not.toHaveBeenCalledWith(lexKey, 0, -1, {
      REV: true,
    });
  });

  it("getPage should return object pagination on a single page", async function () {
    const key = `blog:${this.blog.id}:entries`;
    const now = Date.now();

    await redis.zAdd(key, { score: now, value: "/only.txt" });

    spyOn(Entry, "get").and.callFake((blogID, ids) => {
      if (Array.isArray(ids)) return Promise.resolve(ids.map((id) => ({ id })));
      return Promise.resolve({ id: ids });
    });

    const { entries, pagination } = await Entries.getPage(this.blog.id, {
      pageNumber: 1,
      pageSize: 10,
      sortBy: "date",
    });

    expect(entries.map((entry) => entry.id)).toEqual(["/only.txt"]);
    expect(pagination).toEqual({
      current: 1,
      next: null,
      previous: null,
      total: 1,
      page_size: 10,
      total_entries: 1,
    });
    expect(entries.at(-1).pagination).toEqual(pagination);
  });

  it("getPage should report total as 1 (not 0) when the blog has no entries", async function () {
    const { entries, pagination } = await Entries.getPage(this.blog.id, {
      pageNumber: 1,
      pageSize: 10,
      sortBy: "date",
    });

    expect(entries).toEqual([]);
    expect(pagination.current).toBe(1);
    expect(pagination.total).toBe(1);
  });

  it("getPage should reject with the Redis error", async function () {
    const failure = new Error("redis down");
    const zRangeSpy = spyOn(redis, "zRange").and.callFake(() =>
      Promise.reject(failure)
    );
    spyOn(console, "error");

    let error;

    try {
      await Entries.getPage(this.blog.id, { pageNumber: 1 });
    } catch (e) {
      error = e;
    }

    zRangeSpy.and.callThrough(); // the blog cleanup needs zRange
    expect(error).toBe(failure);
  });

  it("getRecent should return the most recent entries with their indices", async function () {
    const key = `blog:${this.blog.id}:entries`;

    // Add mock entries in Redis
    await redis.zAdd(key, [
      { score: 1, value: "id1" },
      { score: 2, value: "id2" },
      { score: 3, value: "id3" },
    ]);

    // Mock entries returned by Entry.get
    spyOn(Entry, "get").and.callFake((blogID, ids) => {
      const entries = ids.map((id, index) => ({
        id,
        dateStamp: Date.now() - index * 1000,
      }));
      return Promise.resolve(entries);
    });

    const entries = await Entries.getRecent(this.blog.id);

    expect(entries.map((entry) => entry.id)).toEqual(["id3", "id2", "id1"]);
    expect(entries[0].index).toBe(3);
    expect(entries[1].index).toBe(2);
    expect(entries[2].index).toBe(1);
  });

  it("getRecent should return an empty array if there are no entries", async function () {
    expect(await Entries.getRecent(this.blog.id)).toEqual([]);
  });

  it("getRecent should resolve [] on a Redis failure, or reject on an outage with rejectOnOutage", async function () {
    const outage = new (require("redis").ClientClosedError)();
    const zRangeSpy = spyOn(redis, "zRange").and.callFake(() =>
      Promise.reject(outage)
    );

    expect(await Entries.getRecent(this.blog.id)).toEqual([]);

    let error;

    try {
      await Entries.getRecent(this.blog.id, { rejectOnOutage: true });
    } catch (e) {
      error = e;
    }

    zRangeSpy.and.callThrough(); // the blog cleanup needs zRange
    expect(error).toBe(outage);
  });

  it("getAll should resolve the entries, skinny by default", async function () {
    await Entry.set(this.blog.id, "/a.txt", buildEntry("/a.txt"));

    const entries = await Entries.getAll(this.blog.id);

    expect(entries.map((entry) => entry.path)).toEqual(["/a.txt"]);
  });

  it("getAll should resolve [] on a Redis failure, or reject on an outage with rejectOnOutage", async function () {
    const outage = new (require("redis").ClientClosedError)();
    const zRangeSpy = spyOn(redis, "zRange").and.callFake(() =>
      Promise.reject(outage)
    );

    expect(await Entries.getAll(this.blog.id)).toEqual([]);

    let error;

    try {
      await Entries.getAll(this.blog.id, { rejectOnOutage: true });
    } catch (e) {
      error = e;
    }

    zRangeSpy.and.callThrough(); // the blog cleanup needs zRange
    expect(error).toBe(outage);
  });

  describe("path index maintenance", function () {
    it("updates lex index for changed entries", async function () {
      const blogID = this.blog.id;
      const entriesKey = `blog:${blogID}:entries`;
      const lexKey = `blog:${blogID}:entries:lex`;
      const now = Date.now();

      await redis.zAdd(entriesKey, { score: now, value: "/Blog/existing.txt" });

      await redis
        .multi()
        .zAdd(lexKey, { score: 0, value: "/Blog/existing.txt" })
        .exec();

      await Entry.set(blogID, "/Blog/new.txt", buildEntry("/Blog/new.txt"));

      const ids = await redis.zRange(lexKey, 0, -1);
      expect(ids).toContain("/Blog/existing.txt");
      expect(ids).toContain("/Blog/new.txt");
    });
  });
  describe("path prefix pagination", function () {
    beforeEach(function () {
      spyOn(Entry, "get").and.callFake((blogID, ids) => {
        if (!Array.isArray(ids)) return Promise.resolve({ id: ids });
        return Promise.resolve(ids.map((id) => ({ id })));
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
        .exec();
    }

    it("filters posts by path prefix and paginates by id", async function () {
      const blogID = this.blog.id;
      await seedPathPrefixEntries(blogID);

      const { entries, pagination } = await Entries.getPage(blogID, {
        pageNumber: 1,
        pageSize: 2,
        sortBy: "id",
        order: "asc",
        pathPrefix: "/Blog/",
      });

      expect(entries.map((entry) => entry.id)).toEqual([
        "/Blog/a.txt",
        "/Blog/b.txt",
      ]);
      expect(pagination).toEqual({
        current: 1,
        next: 2,
        previous: null,
        total: 2,
        page_size: 2,
        total_entries: 3,
      });
      expect(entries.at(-1).pagination).toEqual(pagination);
    });

    it("normalizes pathPrefix values missing a leading slash", async function () {
      const blogID = this.blog.id;
      await seedPathPrefixEntries(blogID);

      const { entries } = await Entries.getPage(blogID, {
        pageNumber: 1,
        pageSize: 2,
        sortBy: "id",
        order: "asc",
        pathPrefix: "Blog/",
      });

      expect(entries.map((entry) => entry.id)).toEqual([
        "/Blog/a.txt",
        "/Blog/b.txt",
      ]);
    });

    it("applies Redis-compatible tie ordering for equal date scores under pathPrefix", async function () {
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
        .exec();

      const taggedSetKey = `blog:${blogID}:tags:sorted:redis-tie-check`;

      await redis.del(taggedSetKey);
      await redis.zAdd(taggedSetKey, [
        { score: tieScore, value: tieIDs[0] },
        { score: tieScore, value: tieIDs[1] },
        { score: tieScore, value: tieIDs[2] },
      ]);

      const expectedAsc = await redis.zRange(taggedSetKey, 0, -1, {
        REV: true,
      });
      const expectedDesc = await redis.zRange(taggedSetKey, 0, -1);

      const asc = await Entries.getPage(blogID, {
        pageNumber: 1,
        pageSize: 10,
        sortBy: "date",
        order: "asc",
        pathPrefix: "/Blog/",
      });
      expect(asc.entries.map((entry) => entry.id)).toEqual(expectedAsc);

      const desc = await Entries.getPage(blogID, {
        pageNumber: 1,
        pageSize: 10,
        sortBy: "date",
        order: "desc",
        pathPrefix: "/Blog/",
      });
      expect(desc.entries.map((entry) => entry.id)).toEqual(expectedDesc);
    });
    it("ignores empty or whitespace pathPrefix values", async function () {
      const blogID = this.blog.id;
      await seedPathPrefixEntries(blogID);

      const { entries } = await Entries.getPage(blogID, {
        pageNumber: 1,
        pageSize: 4,
        sortBy: "id",
        order: "asc",
        pathPrefix: "   ",
      });

      expect(entries.map((entry) => entry.id)).toEqual([
        "/Blog/a.txt",
        "/Blog/b.txt",
        "/Blog/c.txt",
        "/Notes/d.txt",
      ]);
    });
  });
  describe("adjacentTo", function () {
    beforeEach(function () {
      spyOn(Entry, "get").and.callFake((blogID, ids) => {
        const entries = ids.map((id) => ({ id }));
        return Promise.resolve(entries);
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

    it("reads only the neighbours, never the entry itself", async function (done) {
      const key = `blog:${this.blog.id}:entries`;

      await redis.zAdd(key, [
        { score: 1, value: "id1" },
        { score: 2, value: "id2" },
        { score: 3, value: "id3" },
      ]);

      Entries.adjacentTo(this.blog.id, "id2", function () {
        expect(Entry.get.calls.mostRecent().args[1]).toEqual(["id1", "id3"]);
        done();
      });
    });

    it("reads nothing for the only entry", async function (done) {
      const key = `blog:${this.blog.id}:entries`;

      await redis.zAdd(key, [{ score: 1, value: "id1" }]);

      Entries.adjacentTo(this.blog.id, "id1", function (next, previous, rank) {
        expect(next).toBeUndefined();
        expect(previous).toBeUndefined();
        expect(rank).toBe(1);
        expect(Entry.get.calls.mostRecent().args[1]).toEqual([]);
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

      spyOn(Entry, "get").and.callFake(function (blogID, entryID) {
        if (entryID === "missing") return Promise.resolve({ id: entryID });

        return Promise.resolve({ id: entryID, url: "/valid" });
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

      spyOn(Entry, "get").and.callFake(function (blogID, entryID) {
        calls++;
        return Promise.resolve({ id: entryID });
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
        { path: "entry1", id: "id1", metadata: {} },
        { path: "entry2", id: "id2", metadata: {} },
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
      spyOn(Entry, "get").and.callFake((blogID, id) => {
        const result = entries.find((entry) => entry.id === id);
        return Promise.resolve(result);
      });

      // Mock Entry.set
      spyOn(Entry, "set").and.callFake(async (blogID, path, changes) => {
        expect(changes).toEqual(jasmine.any(Object));
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

  describe("promise form of the reads", function () {
    it("returns promises when called without a callback", async function () {
      const key = `blog:${this.blog.id}:entries`;

      await redis.zAdd(key, [
        { score: 1, value: "/a" },
        { score: 2, value: "/b" },
      ]);

      expect(await Entries.getTotal(this.blog.id)).toBe(2);
      expect(await Entries.getListIDs(this.blog.id, "entries", {})).toEqual([
        "/b",
        "/a",
      ]);
      expect(await Entries.getAllIDs(this.blog.id)).toEqual([]);
      expect(await Entries.getAllTotal(this.blog.id)).toBe(0);
      expect(await Entries.getCreated(this.blog.id, 0)).toEqual([]);
      expect(await Entries.getDeleted(this.blog.id, 0)).toEqual([]);
      expect(await Entries.lastUpdate(this.blog.id)).toBeUndefined();
    });

    it("rejects for invalid arguments", async function () {
      await expectAsync(Entries.getCreated(this.blog.id)).toBeRejected();
    });
  });
});
