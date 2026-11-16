describe("storage/sweep generated files", function () {
  global.test.blog();

  const config = require("config");
  const client = require("models/client");
  const Blog = require("models/blog");
  const bunnyStorage = require("helper/bunnyStorage");
  const Keys = require("helper/transformer/keys");
  const assets = require("storage/assets");
  const s3 = require("storage/s3");
  const references = require("storage/sweep/references");
  const generated = require("storage/sweep/generated");
  const cache = require("storage/sweep/cache");
  const sweep = require("storage/sweep");

  const DAY = 24 * 60 * 60 * 1000;
  const NOW = Date.now();
  const OLD = new Date(NOW - 3 * DAY);

  let store; // object key -> { size, modified }
  let deleted; // each call of deleteKeys
  let used;

  beforeEach(function () {
    store = new Map();
    deleted = [];
    used = new Set();

    spyOn(references, "inUse").and.callFake(async () => used);
    spyOn(assets, "walkEntries").and.callFake(() =>
      (async function* () {
        for (const [key, object] of Array.from(store)) {
          const rel = key.slice(key.indexOf("/") + 1);
          yield { relPath: rel, modified: object.modified, size: object.size };
        }
      })()
    );
    spyOn(s3, "deleteKeys").and.callFake(async (keys) => {
      deleted.push(keys);
      for (const key of keys) store.delete(key);
    });
  });

  afterEach(async function () {
    const id = this.blog.id;

    for (const name of cache.NAMES) {
      const everything = Keys(id, name).everything;
      const members = await client.sMembers(everything);

      if (members.length) await client.del(members);

      await client.del(everything);
    }

    await client.del([generated.candidatesKey(id), generated.markedKey(id)]);
    await client.del(sweep.STATE);
  });

  // Files in the bucket, one per directory name, e.g. "_thumbnails/old"
  function put(id, dir, options = {}) {
    store.set(id + "/" + dir + "/" + (options.file || "small.jpg"), {
      size: options.size || 10,
      modified: options.modified || OLD,
    });
  }

  // A cache entry for a directory, and with a URL if given: the transformer
  // keys a lookup writes
  async function entry(id, name, dir, url) {
    const keys = Keys(id, name);
    const content = keys.content("h" + dir.replace(/\W/g, ""));
    const members = [content];

    await client.set(
      content,
      JSON.stringify({ small: { path: "/" + dir + "/small.jpg" } })
    );

    if (url) {
      await client.set(keys.url.content(url), content.split(":").pop());
      await client.set(keys.url.headers(url), "{}");
      members.push(keys.url.content(url), keys.url.headers(url));
    }

    await client.sAdd(keys.everything, members);

    return members;
  }

  async function exists(keys) {
    return (await client.exists(keys)) === keys.length;
  }

  function newTotals() {
    return {
      generatedBlogs: 0,
      candidates: 0,
      candidateBytes: 0,
      deletedDirs: 0,
      deletedBytes: 0,
      cacheKeysDeleted: 0,
      legacyCacheKeys: 0,
    };
  }

  async function run(id, mode, options = {}) {
    const totals = newTotals();
    const files = await generated.run(id, {
      mode,
      totals,
      now: () => NOW,
      log: () => {},
      ...options,
    });

    return { totals, files };
  }

  async function candidates(id) {
    return (await client.sMembers(generated.candidatesKey(id))).sort();
  }

  it("report mode writes nothing and totals what apply would do", async function () {
    const id = this.blog.id;
    const keys = await entry(id, "thumbnails", "_thumbnails/old", "http://a/b");

    put(id, "_thumbnails/old", { size: 30 });

    const report = await run(id, "report");

    expect(report.totals).toEqual({
      generatedBlogs: 1,
      candidates: 1,
      candidateBytes: 30,
      deletedDirs: 0,
      deletedBytes: 0,
      cacheKeysDeleted: 3,
      legacyCacheKeys: 0,
    });
    expect(await client.exists(generated.candidatesKey(id))).toBe(0);
    expect(await exists(keys)).toBe(true);
    expect(await client.sCard(Keys(id, "thumbnails").everything)).toBe(3);
    expect(deleted).toEqual([]);
    expect(store.size).toBe(1);

    const apply = await run(id, "apply");

    expect(apply.totals).toEqual(report.totals);
  });

  it("report mode totals the deletes a recorded candidate would get", async function () {
    const id = this.blog.id;

    put(id, "_thumbnails/old", { size: 30 });
    await client.sAdd(generated.candidatesKey(id), "_thumbnails/old");

    const report = await run(id, "report");

    expect(report.totals.deletedDirs).toBe(1);
    expect(report.totals.deletedBytes).toBe(30);
    expect(deleted).toEqual([]);
    expect(await candidates(id)).toEqual(["_thumbnails/old"]);
  });

  it("run 1 deletes the cache entries and records the candidate, deleting no objects", async function () {
    const id = this.blog.id;
    const thumbnails = await entry(id, "thumbnails", "_thumbnails/old", "u1");
    const images = await entry(id, "image-cache", "_image_cache/x", "u2");
    const keep = await entry(id, "thumbnails", "_thumbnails/live", "u3");

    put(id, "_thumbnails/old");
    put(id, "_thumbnails/live");
    put(id, "_image_cache/x");
    used.add("_thumbnails/live");

    const { totals } = await run(id, "apply");

    expect(totals.candidates).toBe(2);
    expect(totals.cacheKeysDeleted).toBe(6);
    expect(await client.exists(thumbnails)).toBe(0);
    expect(await client.exists(images)).toBe(0);
    expect(await exists(keep)).toBe(true);
    expect(await client.sCard(Keys(id, "thumbnails").everything)).toBe(3);
    expect(await candidates(id)).toEqual(["_image_cache/x", "_thumbnails/old"]);
    expect(deleted).toEqual([]);
    expect(store.size).toBe(3);
  });

  it("deletes only candidates marked before markedBefore", async function () {
    const id = this.blog.id;

    put(id, "_thumbnails/old");
    await run(id, "apply");

    // Marked at NOW: a run that started at NOW keeps it
    const same = await run(id, "apply", { markedBefore: NOW });
    expect(same.totals.deletedDirs).toBe(0);
    expect(await candidates(id)).toEqual(["_thumbnails/old"]);

    const later = await run(id, "apply", {
      now: () => NOW + 1000,
      markedBefore: NOW + 1,
    });
    expect(later.totals.deletedDirs).toBe(1);
  });

  it("treats a candidate set with no time as just marked", async function () {
    const id = this.blog.id;

    put(id, "_thumbnails/old");
    await client.sAdd(generated.candidatesKey(id), "_thumbnails/old");

    const weekly = await run(id, "apply", { markedBefore: NOW + 1 });
    expect(weekly.totals.deletedDirs).toBe(0);

    const byHand = await run(id, "apply");
    expect(byHand.totals.deletedDirs).toBe(1);
  });

  it("run 2 deletes the candidate's objects", async function () {
    const id = this.blog.id;

    put(id, "_thumbnails/old", { size: 30 });
    put(id, "_thumbnails/old", { file: "large.jpg", size: 5 });
    put(id, "_thumbnails/live");
    used.add("_thumbnails/live");

    await run(id, "apply");
    expect(deleted).toEqual([]);

    const { totals, files } = await run(id, "apply");

    expect(totals.deletedDirs).toBe(1);
    expect(totals.deletedBytes).toBe(35);
    expect(deleted.map((keys) => keys.slice().sort())).toEqual([
      [id + "/_thumbnails/old/large.jpg", id + "/_thumbnails/old/small.jpg"],
    ]);
    expect(Array.from(files.keys())).toEqual(["_thumbnails/live/small.jpg"]);
    expect(await client.exists(generated.candidatesKey(id))).toBe(0);
  });

  it("keeps a directory that is referenced again between the runs", async function () {
    const id = this.blog.id;

    put(id, "_thumbnails/old");

    await run(id, "apply");
    used.add("_thumbnails/old");

    const { totals } = await run(id, "apply");

    expect(totals.deletedDirs).toBe(0);
    expect(totals.candidates).toBe(0);
    expect(deleted).toEqual([]);
    expect(await client.exists(generated.candidatesKey(id))).toBe(0);
  });

  it("keeps a directory a cache entry points at again, for one more round", async function () {
    const id = this.blog.id;

    put(id, "_thumbnails/old");
    await entry(id, "thumbnails", "_thumbnails/old");
    await run(id, "apply");

    const again = await entry(id, "thumbnails", "_thumbnails/old");
    const second = await run(id, "apply");

    expect(second.totals.deletedDirs).toBe(0);
    expect(deleted).toEqual([]);
    expect(await candidates(id)).toEqual(["_thumbnails/old"]);
    expect(await client.exists(again)).toBe(0);

    const third = await run(id, "apply");

    expect(third.totals.deletedDirs).toBe(1);
  });

  it("never marks a directory whose newest file is under a day old", async function () {
    const id = this.blog.id;

    put(id, "_thumbnails/old");
    put(id, "_thumbnails/old", {
      file: "new.jpg",
      modified: new Date(NOW - DAY / 2),
    });
    put(id, "_thumbnails/fresh", { modified: new Date(NOW - 1000) });
    await client.sAdd(generated.candidatesKey(id), [
      "_thumbnails/old",
      "_thumbnails/fresh",
    ]);

    const { totals } = await run(id, "apply");

    expect(totals.candidates).toBe(0);
    expect(totals.deletedDirs).toBe(0);
    expect(deleted).toEqual([]);
    expect(await client.exists(generated.candidatesKey(id))).toBe(0);
  });

  it("deletes the cache entries of a directory missing from the bucket, and stale members", async function () {
    const id = this.blog.id;
    const gone = await entry(id, "image-cache", "_image_cache/gone", "u1");
    const here = await entry(id, "image-cache", "_image_cache/here", "u2");
    const everything = Keys(id, "image-cache").everything;

    put(id, "_image_cache/here");
    used.add("_image_cache/here");
    await client.sAdd(everything, Keys(id, "image-cache").content("nothing"));
    // a URL whose content has gone
    await client.set(Keys(id, "image-cache").url.content("u9"), "missing");
    await client.set(Keys(id, "image-cache").url.headers("u9"), "{}");
    await client.sAdd(everything, [
      Keys(id, "image-cache").url.content("u9"),
      Keys(id, "image-cache").url.headers("u9"),
    ]);

    const { totals } = await run(id, "apply");

    expect(totals.cacheKeysDeleted).toBe(6);
    expect(await client.exists(gone)).toBe(0);
    expect(await exists(here)).toBe(true);
    expect(await client.sMembers(everything)).toEqual(
      jasmine.arrayContaining(here)
    );
    expect(await client.sCard(everything)).toBe(3);
    expect(deleted).toEqual([]);
  });

  it("leaves the other transformer names alone", async function () {
    const id = this.blog.id;
    const keys = await entry(id, "img-converter", "_assets/x", "u1");

    await run(id, "apply");

    expect(await exists(keys)).toBe(true);
    await client.del(keys);
    await client.del(Keys(id, "img-converter").everything);
  });

  it("deletes a screenshot by its exact key, not its neighbours", async function () {
    const id = this.blog.id;

    for (const name of ["abc.png", "abc.png2", "abcd.png"])
      store.set(id + "/_bookmark_screenshots/" + name, {
        size: 1,
        modified: OLD,
      });

    store.set(id + "/_bookmark_screenshots/dir/x.png", {
      size: 1,
      modified: OLD,
    });
    used.add("_bookmark_screenshots/abc.png2");
    used.add("_bookmark_screenshots/abcd.png");
    used.add("_bookmark_screenshots/dir");

    await run(id, "apply");
    await run(id, "apply");

    expect(deleted).toEqual([[id + "/_bookmark_screenshots/abc.png"]]);
    expect(Array.from(store.keys()).sort()).toEqual([
      id + "/_bookmark_screenshots/abc.png2",
      id + "/_bookmark_screenshots/abcd.png",
      id + "/_bookmark_screenshots/dir/x.png",
    ]);
  });

  it("deletes nothing when a read fails", async function () {
    const id = this.blog.id;

    put(id, "_thumbnails/old");
    await client.sAdd(generated.candidatesKey(id), "_thumbnails/old");
    references.inUse.and.callFake(async () => {
      throw new Error("Redis went away");
    });

    const err = await run(id, "apply").catch((err) => err);

    expect(err.message).toBe("Redis went away");
    expect(deleted).toEqual([]);
    expect(await candidates(id)).toEqual(["_thumbnails/old"]);
  });

  describe("in the weekly run, with Perma-Cache", function () {
    const ROOT = "__bcdn_perma_cache__/";
    const BASE = ROOT + "pullzone__" + config.bunny.pull_zone + "__1/";
    let purged;

    // A storage zone holding each URL path (as in permaCache's spec)
    function zone(paths) {
      const dirs = {
        [ROOT]: [
          {
            name: "pullzone__" + config.bunny.pull_zone + "__1",
            isDirectory: true,
          },
        ],
      };

      for (const path of paths) {
        const segments = path.slice(1).split("/");
        let dir = BASE;

        segments.forEach((segment, i) => {
          const name =
            i === segments.length - 1 ? "___" + segment + "___" : segment;
          dirs[dir] = dirs[dir] || [];
          if (!dirs[dir].some((entry) => entry.name === name))
            dirs[dir].push({ name, isDirectory: true });
          dir += name + "/";
        });

        dirs[dir] = [{ name: "___file___", isDirectory: false }];
      }

      spyOn(bunnyStorage, "list").and.callFake(async (dir) => dirs[dir] || []);
      spyOn(bunnyStorage, "remove").and.callFake(async () => {});
    }

    // The sweep modules, loaded again with the purge replaced
    async function withSweep(fn) {
      const purge = require.cache[require.resolve("helper/purgeCdnUrls")];
      const real = purge.exports;
      const names = ["storage/sweep/permaCache", "storage/sweep"];

      purge.exports = async (urls) => {
        purged.push(...urls);
        return true;
      };
      names.forEach((name) => delete require.cache[require.resolve(name)]);

      try {
        return await fn(require("storage/sweep"));
      } finally {
        purge.exports = real;
        names.forEach((name) => delete require.cache[require.resolve(name)]);
      }
    }

    beforeEach(function () {
      purged = [];
      spyOn(Blog, "getAllIDs").and.callFake(async () => [this.blog.id]);
    });

    const HOUR = 60 * 60 * 1000;

    // A clock that moves on each reading, so that what the main pass marks
    // is marked before it ends. Set time to jump ahead.
    function clock() {
      const c = { time: NOW };

      c.now = () => ++c.time;

      return c;
    }

    async function savedTotals() {
      return JSON.parse(await client.hGet(sweep.STATE, "totals"));
    }

    // Any hour: the specs that aren't about the start window don't care
    // when the clock says it is
    const ANY_HOUR = { from: 0, to: 24 };

    function options(c, extra = {}) {
      return {
        now: c.now,
        generated: "apply",
        log: () => {},
        window: ANY_HOUR,
        ...extra,
      };
    }

    it("marks in the main pass and leaves the run unfinished", async function () {
      const id = this.blog.id;
      const c = clock();

      put(id, "_thumbnails/old");
      zone([]);

      await withSweep(async (fresh) => {
        expect(await fresh.step(null, options(c))).toBe(null);

        const state = await client.hGetAll(fresh.STATE);

        expect(state.startedAt).toBeDefined();
        expect(state.finishedAt).toBeUndefined();
        expect(Number(state.mainDoneAt)).toBeGreaterThan(NOW);
        expect((await savedTotals()).candidates).toBe(1);
        expect(await candidates(id)).toEqual(["_thumbnails/old"]);
        expect(store.has(id + "/_thumbnails/old/small.jpg")).toBe(true);
      });
    });

    it("does nothing before six hours have passed", async function () {
      const id = this.blog.id;
      const c = clock();

      put(id, "_thumbnails/old");
      zone([]);

      await withSweep(async (fresh) => {
        await fresh.step(null, options(c));

        const done = Number(await client.hGet(fresh.STATE, "mainDoneAt"));

        c.time = done + fresh.SECOND_PASS_DELAY - 10;

        expect(await fresh.step(null, options(c))).toBe(null);
        expect(deleted).toEqual([]);
        expect(await client.hGet(fresh.STATE, "finishedAt")).toBe(null);
        expect(await candidates(id)).toEqual(["_thumbnails/old"]);
      });
    });

    it("deletes the candidates six hours later and finishes the run", async function () {
      const id = this.blog.id;
      const url = config.cdn.origin + "/" + id + "/_thumbnails/old/small.jpg";
      const c = clock();

      put(id, "_thumbnails/old");
      zone([
        `/${id}/_thumbnails/old/small.jpg`,
        `/${id}/_thumbnails/other/small.jpg`,
      ]);

      await withSweep(async (fresh) => {
        await fresh.step(null, options(c));

        // The main pass purged what was already gone, not the candidate
        expect(purged).toEqual([
          config.cdn.origin + "/" + id + "/_thumbnails/other/small.jpg",
        ]);
        purged.length = 0;

        c.time += 6 * HOUR + 10;

        const totals = await fresh.step(null, options(c));

        expect(totals.deletedDirs).toBe(1);
        expect(totals.candidates).toBe(1);
        expect(totals.generatedBlogs).toBe(2);
        expect(totals.secondPassBlogs).toBe(1);
        expect(purged).toContain(url);
        expect(store.has(id + "/_thumbnails/old/small.jpg")).toBe(false);
        expect(await candidates(id)).toEqual([]);

        const state = await client.hGetAll(fresh.STATE);

        expect(state.startedAt).toBeUndefined();
        expect(state.mainDoneAt).toBeUndefined();
        expect(state.secondCursor).toBeUndefined();
        expect(Number(state.finishedAt)).toBeGreaterThan(NOW);

        // The next run waits an interval
        expect(await fresh.step(null, options(c))).toBe(null);
      });
    });

    it("resumes the second pass from its cursor without redoing blogs", async function () {
      const id = this.blog.id;
      const c = clock();

      put(id, "_thumbnails/old");
      zone([]);

      await withSweep(async (fresh) => {
        await fresh.step(null, options(c));

        // A deploy killed the second pass after this blog was done
        await client.hSet(fresh.STATE, { secondCursor: id });
        c.time += 6 * HOUR + 10;

        const totals = await fresh.step(null, options(c));

        expect(totals.secondPassBlogs).toBe(0);
        expect(totals.deletedDirs).toBe(0);
        expect(store.has(id + "/_thumbnails/old/small.jpg")).toBe(true);
        expect(await client.hGet(fresh.STATE, "finishedAt")).not.toBe(null);
      });
    });

    it("finishes right after the main pass in report mode", async function () {
      const id = this.blog.id;
      const c = clock();

      put(id, "_thumbnails/old");
      zone([]);

      await withSweep(async (fresh) => {
        const totals = await fresh.step(
          null,
          options(c, { generated: "report" })
        );

        expect(totals.candidates).toBe(1);
        expect(totals.secondPassBlogs).toBe(0);

        const state = await client.hGetAll(fresh.STATE);

        expect(state.finishedAt).toBeDefined();
        expect(state.mainDoneAt).toBeUndefined();
        expect(state.startedAt).toBeUndefined();
        expect(await candidates(id)).toEqual([]);
      });
    });

    it("keeps a candidate referenced again before the second pass", async function () {
      const id = this.blog.id;
      const c = clock();

      put(id, "_thumbnails/old");
      zone([]);

      await withSweep(async (fresh) => {
        await fresh.step(null, options(c));
        used.add("_thumbnails/old");
        c.time += 6 * HOUR + 10;

        const totals = await fresh.step(null, options(c));

        expect(totals.deletedDirs).toBe(0);
        expect(totals.secondPassBlogs).toBe(1);
        expect(store.has(id + "/_thumbnails/old/small.jpg")).toBe(true);
        expect(await candidates(id)).toEqual([]);
      });
    });

    it("doesn't delete what the main pass marked when it resumes after a deploy", async function () {
      const id = this.blog.id;
      const c = clock();

      put(id, "_thumbnails/old");
      zone([]);

      await withSweep(async (fresh) => {
        await fresh.step(null, options(c));

        const startedAt = await client.hGet(fresh.STATE, "startedAt");

        // A deploy killed the run with this blog in progress: the next holder
        // resumes the same run (same start) and sweeps the blog again
        await client.hDel(fresh.STATE, "mainDoneAt");
        await client.hSet(fresh.STATE, { startedAt, cursor: "" });

        const resumed = await fresh.step(null, options(c));

        expect(resumed).toBe(null);
        expect((await savedTotals()).deletedDirs).toBe(0);
        expect(await candidates(id)).toEqual(["_thumbnails/old"]);
        expect(store.has(id + "/_thumbnails/old/small.jpg")).toBe(true);

        // The second pass of that run deletes it
        c.time += 6 * HOUR + 10;

        const next = await fresh.step(null, options(c));

        expect(next.deletedDirs).toBe(1);
      });
    });

    it("sweeps a blog with nothing in Perma-Cache", async function () {
      const id = this.blog.id;

      put(id, "_thumbnails/old");
      zone([]);

      await withSweep(async (fresh) => {
        await fresh.step(null, {
          now: () => NOW,
          window: ANY_HOUR,
          generated: "apply",
          log: () => {},
        });

        const totals = await savedTotals();

        expect(totals.generatedBlogs).toBe(1);
        expect(totals.candidates).toBe(1);
        expect(await candidates(id)).toEqual(["_thumbnails/old"]);
      });
    });

    it("counts a failed generated step and still checks Perma-Cache", async function () {
      const id = this.blog.id;

      put(id, "_thumbnails/old");
      await client.sAdd(generated.candidatesKey(id), "_thumbnails/old");
      references.inUse.and.callFake(async () => {
        throw new Error("Redis went away");
      });
      zone([`/${id}/_thumbnails/missing/small.jpg`]);
      spyOn(console, "error");

      await withSweep(async (fresh) => {
        await fresh.step(null, {
          now: () => NOW,
          window: ANY_HOUR,
          generated: "apply",
          log: () => {},
        });

        const totals = await savedTotals();

        expect(totals.generatedFailed).toBe(1);
        expect(totals.failed).toBe(1);
        expect(deleted).toEqual([]);
        expect(purged).toEqual([
          config.cdn.origin + "/" + id + "/_thumbnails/missing/small.jpg",
        ]);
      });
    });

    it("loads totals saved by a run from before the generated step", async function () {
      zone([]);

      await client.hSet(sweep.STATE, {
        startedAt: "1",
        cursor: "",
        totals: JSON.stringify({
          entries: 4,
          deletedBlogs: 0,
          stale: 2,
          failed: 0,
        }),
      });

      await withSweep(async (fresh) => {
        const totals = await fresh.step(null, {
          now: () => NOW,
          window: ANY_HOUR,
          generated: "off",
        });

        expect(totals.stale).toBe(2);
        expect(totals.entries).toBeGreaterThanOrEqual(4);
        expect(totals.cacheKeysDeleted).toBe(0);
      });
    });

    describe("skipping blogs unchanged since the last run", function () {
      const blogKey = require("models/blog/key");
      // The previous run: started 8 days and a few hours ago, finished 8 days ago
      const PREVIOUS_START = NOW - 8 * DAY - 3 * HOUR;
      const PREVIOUS_END = NOW - 8 * DAY;

      async function previousRun(extra = {}) {
        await client.hSet(sweep.STATE, {
          finishedAt: String(PREVIOUS_END),
          previousStartedAt: String(PREVIOUS_START),
          runs: "1",
          ...extra,
        });
      }

      async function cacheID(id, value) {
        await client.hSet(blogKey.info(id), "cacheID", String(value));
      }

      // A blog in the bucket, in Perma-Cache, to see what a run reads of it
      function setUp(id) {
        put(id, "_thumbnails/old");
        zone([`/${id}/_thumbnails/other/small.jpg`]);
      }

      afterEach(async function () {
        await client.del(sweep.FAILED);
      });

      it("skips an unchanged blog with no candidates, reading neither entries, S3 nor Perma-Cache", async function () {
        const id = this.blog.id;
        const c = clock();

        await previousRun();
        await cacheID(id, PREVIOUS_START - 3 * DAY);
        setUp(id);

        await withSweep(async (fresh) => {
          await fresh.step(null, options(c));

          const totals = await savedTotals();

          expect(totals.skippedUnchanged).toBe(1);
          expect(totals.generatedBlogs).toBe(0);
          expect(references.inUse).not.toHaveBeenCalled();
          expect(assets.walkEntries).not.toHaveBeenCalled();
          expect(bunnyStorage.list).not.toHaveBeenCalledWith(BASE + id + "/");
          expect(purged).toEqual([]);
          expect(await candidates(id)).toEqual([]);
        });
      });

      it("sweeps a blog changed since the previous run started", async function () {
        const id = this.blog.id;
        const c = clock();

        await previousRun();
        await cacheID(id, PREVIOUS_START + HOUR);
        setUp(id);

        await withSweep(async (fresh) => {
          await fresh.step(null, options(c));

          const totals = await savedTotals();

          expect(totals.skippedUnchanged).toBe(0);
          expect(totals.generatedBlogs).toBe(1);
          expect(references.inUse).toHaveBeenCalled();
          expect(await candidates(id)).toEqual(["_thumbnails/old"]);
        });
      });

      it("sweeps a blog changed in the day before the previous run started", async function () {
        const id = this.blog.id;
        const c = clock();

        // What it made unreferenced was too young then to be a candidate
        await previousRun();
        await cacheID(id, PREVIOUS_START - HOUR);
        setUp(id);

        await withSweep(async (fresh) => {
          await fresh.step(null, options(c));

          expect((await savedTotals()).generatedBlogs).toBe(1);
        });
      });

      it("sweeps a blog with a candidate set", async function () {
        const id = this.blog.id;
        const c = clock();

        await previousRun();
        await cacheID(id, PREVIOUS_START - 3 * DAY);
        await client.sAdd(generated.candidatesKey(id), "_thumbnails/old");
        setUp(id);

        await withSweep(async (fresh) => {
          await fresh.step(null, options(c));

          const totals = await savedTotals();

          expect(totals.skippedUnchanged).toBe(0);
          expect(totals.generatedBlogs).toBe(1);
        });
      });

      it("sweeps a blog whose step failed last run, and takes it off the list when it succeeds", async function () {
        const id = this.blog.id;
        const c = clock();

        await previousRun();
        await cacheID(id, PREVIOUS_START - 3 * DAY);
        await client.sAdd(sweep.FAILED, id);
        setUp(id);

        await withSweep(async (fresh) => {
          await fresh.step(null, options(c));

          expect((await savedTotals()).generatedBlogs).toBe(1);
          expect(await client.sIsMember(sweep.FAILED, id)).toBeFalsy();
        });
      });

      it("lists a blog whose generated step throws, so the next run sweeps it", async function () {
        const id = this.blog.id;
        const c = clock();

        await previousRun();
        await cacheID(id, PREVIOUS_START - 3 * DAY);
        references.inUse.and.callFake(async () => {
          throw new Error("Redis went away");
        });
        setUp(id);
        spyOn(console, "error");

        await withSweep(async (fresh) => {
          await fresh.step(null, options(c));

          expect(await client.sIsMember(sweep.FAILED, id)).toBeTruthy();
        });
      });

      it("sweeps everything in the first run, which has no previous run", async function () {
        const id = this.blog.id;
        const c = clock();

        await cacheID(id, 1);
        setUp(id);

        await withSweep(async (fresh) => {
          await fresh.step(null, options(c));

          const totals = await savedTotals();

          expect(totals.skippedUnchanged).toBe(0);
          expect(totals.generatedBlogs).toBe(1);
          expect(await client.hGet(fresh.STATE, "full")).toBe("1");
        });
      });

      it("sweeps everything in every fourth run", async function () {
        const id = this.blog.id;
        const c = clock();

        await previousRun({ runs: String(sweep.FULL_EVERY - 1) });
        await cacheID(id, PREVIOUS_START - 3 * DAY);
        setUp(id);

        await withSweep(async (fresh) => {
          await fresh.step(null, options(c));

          const totals = await savedTotals();

          expect(totals.skippedUnchanged).toBe(0);
          expect(totals.generatedBlogs).toBe(1);
          expect(await client.hGet(fresh.STATE, "full")).toBe("1");
        });
      });

      it("sweeps everything when the step is told to make a full run", async function () {
        const id = this.blog.id;
        const c = clock();

        await previousRun();
        await cacheID(id, PREVIOUS_START - 3 * DAY);
        setUp(id);

        await withSweep(async (fresh) => {
          await fresh.step(null, options(c, { full: true }));

          expect((await savedTotals()).generatedBlogs).toBe(1);
        });
      });

      it("sweeps everything in a run that began before skipping was added", async function () {
        const id = this.blog.id;
        const c = clock();

        // In progress, with no "full" in its state
        await client.hSet(sweep.STATE, {
          startedAt: String(NOW - HOUR),
          cursor: "",
          previousStartedAt: String(PREVIOUS_START),
        });
        await cacheID(id, PREVIOUS_START - 3 * DAY);
        setUp(id);

        await withSweep(async (fresh) => {
          await fresh.step(null, options(c));

          expect((await savedTotals()).generatedBlogs).toBe(1);

          // It records nothing for the next run: its failures weren't listed
          c.time += 6 * HOUR + 10;
          await fresh.step(null, options(c));

          const state = await client.hGetAll(fresh.STATE);

          expect(state.finishedAt).toBeDefined();
          expect(state.previousStartedAt).toBe(String(PREVIOUS_START));
        });
      });

      it("records the start of an applied run, once finished, for the next", async function () {
        const c = clock();

        await previousRun();
        zone([]);

        await withSweep(async (fresh) => {
          await fresh.step(null, options(c));

          const startedAt = await client.hGet(fresh.STATE, "startedAt");

          c.time += 6 * HOUR + 10;
          await fresh.step(null, options(c));

          const state = await client.hGetAll(fresh.STATE);

          expect(state.startedAt).toBeUndefined();
          expect(state.previousStartedAt).toBe(startedAt);
          expect(state.runs).toBe("2");
        });
      });

      it("records nothing for the next run from a report run, and skips nothing in it", async function () {
        const id = this.blog.id;
        const c = clock();

        await previousRun();
        await cacheID(id, PREVIOUS_START - 3 * DAY);
        setUp(id);

        await withSweep(async (fresh) => {
          const totals = await fresh.step(
            null,
            options(c, { generated: "report" })
          );

          expect(totals.skippedUnchanged).toBe(0);
          expect(totals.generatedBlogs).toBe(1);
          expect(await client.hGet(fresh.STATE, "previousStartedAt")).toBe(
            String(PREVIOUS_START)
          );
        });
      });

      it("never skips a blog that is gone or a directory that is not a blog", async function () {
        const id = this.blog.id;
        const gone = "blog_0123456789abcdef0123456789abcdef";
        const c = clock();

        await previousRun();
        await cacheID(id, PREVIOUS_START - 3 * DAY);
        zone([`/${gone}/_a/x.jpg`, "/loose/x"]);

        await withSweep(async (fresh) => {
          await fresh.step(null, options(c));

          const totals = await savedTotals();

          expect(totals.skippedUnchanged).toBe(1);
          expect(totals.deletedBlogs).toBe(1);
          expect(bunnyStorage.remove).toHaveBeenCalledWith(BASE + gone + "/");
          expect(bunnyStorage.remove).toHaveBeenCalledWith(BASE + "loose/");
        });
      });
    });

    describe("the start window", function () {
      const AT_NIGHT = Date.UTC(2026, 10, 16, 3, 30);
      const AT_NOON = Date.UTC(2026, 10, 16, 12, 30);

      it("doesn't start a run outside the window", async function () {
        zone([]);

        await withSweep(async (fresh) => {
          const outside = {
            now: () => AT_NOON,
            generated: "apply",
            log: () => {},
          };

          expect(await fresh.step(null, outside)).toBe(null);
          expect(await client.hGet(fresh.STATE, "startedAt")).toBe(null);
        });
      });

      it("starts a run inside the window", async function () {
        zone([]);

        await withSweep(async (fresh) => {
          await fresh.step(null, {
            now: () => AT_NIGHT,
            generated: "apply",
            log: () => {},
          });

          expect(await client.hGet(fresh.STATE, "startedAt")).toBe(
            String(AT_NIGHT)
          );
        });
      });

      it("doesn't start a run in the window before the interval has passed", async function () {
        zone([]);

        await client.hSet(sweep.STATE, {
          finishedAt: String(AT_NIGHT - DAY),
        });

        await withSweep(async (fresh) => {
          expect(
            await fresh.step(null, {
              now: () => AT_NIGHT,
              generated: "apply",
              log: () => {},
            })
          ).toBe(null);
          expect(await client.hGet(fresh.STATE, "startedAt")).toBe(null);
        });
      });

      it("carries on a run in progress, and its second pass, outside the window", async function () {
        const id = this.blog.id;

        put(id, "_thumbnails/old");
        zone([]);

        await client.hSet(sweep.STATE, {
          startedAt: String(AT_NOON - HOUR),
          cursor: "",
        });

        await withSweep(async (fresh) => {
          const outside = (time) => ({
            now: () => time,
            generated: "apply",
            log: () => {},
          });

          await fresh.step(null, outside(AT_NOON));

          const mainDoneAt = await client.hGet(fresh.STATE, "mainDoneAt");

          expect(mainDoneAt).not.toBe(null);

          const later = AT_NOON + 6 * HOUR + 10;
          const totals = await fresh.step(null, outside(later));

          expect(totals.secondPassBlogs).toBe(1);
          expect(await client.hGet(fresh.STATE, "finishedAt")).toBe(
            String(later)
          );
        });
      });
    });
  });

  describe("legacy results", function () {
    const LEGACY_IMAGE =
      '{"url":"//blotcdn.com/1da9c32116/image-cache/1532083907566/w3ikrr-gallery.jpg","width":640,"height":426}';
    const LEGACY_THUMBNAILS =
      '{"small":{"width":160,"height":107,"url":"//blotcdn.com/1da9c32116/thumbnails/1532083929704/qjwy0.jpg"}}';

    // A result stored under a content key, with a URL pair if given
    async function stored(id, name, hash, value, url) {
      const keys = Keys(id, name);
      const content = keys.content(hash);
      const members = [content];

      await client.set(content, value);

      if (url) {
        await client.set(keys.url.content(url), hash);
        await client.set(keys.url.headers(url), "{}");
        members.push(keys.url.content(url), keys.url.headers(url));
      }

      await client.sAdd(keys.everything, members);

      return members;
    }

    it("report mode counts them with their URL pair and deletes nothing", async function () {
      const id = this.blog.id;
      const image = await stored(
        id,
        "image-cache",
        "legacyimage",
        LEGACY_IMAGE,
        "http://a/legacy.jpg"
      );
      const thumbnails = await stored(
        id,
        "thumbnails",
        "legacythumbs",
        LEGACY_THUMBNAILS
      );

      const { totals } = await run(id, "report");

      expect(totals.cacheKeysDeleted).toBe(4);
      expect(totals.legacyCacheKeys).toBe(4);
      expect(await exists(image)).toBe(true);
      expect(await exists(thumbnails)).toBe(true);
      expect(await client.sCard(Keys(id, "image-cache").everything)).toBe(3);
    });

    it("apply mode deletes them and takes them out of the everything set", async function () {
      const id = this.blog.id;
      const image = await stored(
        id,
        "image-cache",
        "legacyimage",
        LEGACY_IMAGE,
        "http://a/legacy.jpg"
      );
      const thumbnails = await stored(
        id,
        "thumbnails",
        "legacythumbs",
        LEGACY_THUMBNAILS
      );

      const { totals } = await run(id, "apply");

      expect(totals.legacyCacheKeys).toBe(4);
      expect(await client.exists(image)).toBe(0);
      expect(await client.exists(thumbnails)).toBe(0);
      expect(await client.sCard(Keys(id, "image-cache").everything)).toBe(0);
      expect(await client.sCard(Keys(id, "thumbnails").everything)).toBe(0);
    });

    it("leaves a current result next to them alone", async function () {
      const id = this.blog.id;

      used.add("_image_cache/current");
      put(id, "_image_cache/current");

      const keep = await entry(
        id,
        "image-cache",
        "_image_cache/current",
        "http://a/current.jpg"
      );

      await stored(id, "image-cache", "legacyimage", LEGACY_IMAGE);

      const { totals } = await run(id, "apply");

      expect(totals.legacyCacheKeys).toBe(1);
      expect(totals.cacheKeysDeleted).toBe(1);
      expect(await exists(keep)).toBe(true);
    });

    it("does not treat a result that also names a current scope as legacy", async function () {
      const id = this.blog.id;

      used.add("_image_cache/abc");
      put(id, "_image_cache/abc");

      const mixed = await stored(
        id,
        "image-cache",
        "mixed",
        JSON.stringify({
          url: "//blotcdn.com/x/image-cache/1532083907566/a.jpg",
          src: "/_image_cache/abc/a.jpg",
        })
      );

      const { totals } = await run(id, "apply");

      expect(totals.legacyCacheKeys).toBe(0);
      expect(await exists(mixed)).toBe(true);
    });
  });
});
