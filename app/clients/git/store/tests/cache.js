const fs = require("fs");
const os = require("os");
const path = require("path");
const { fork } = require("child_process");
const { Readable } = require("stream");
const createCache = require("../cache");
const timeout = require("./helpers/timeout");
const { NoRoomError } = require("../errors");

// Bytes in the cache's entries
function entryBytes(dir) {
  let total = 0;
  const root = path.join(dir, "entries");
  if (!fs.existsSync(root)) return 0;
  for (const entry of fs.readdirSync(root, { withFileTypes: true, recursive: true })) {
    try {
      if (entry.isFile()) total += fs.statSync(path.join(entry.parentPath, entry.name)).size;
    } catch (err) {
      // deleted while we were counting
    }
  }
  return total;
}

function entryFiles(dir) {
  const root = path.join(dir, "entries");
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name));
}

// The file of the entry for `key`
function fileOf(dir, key) {
  const name = require("crypto").createHash("sha256").update(key).digest("hex");
  return path.join(dir, "entries", name.slice(0, 2), name);
}

// An entry's file, made older: what the walk evicts by
function age(file, msAgo) {
  const when = (Date.now() - msAgo) / 1000;
  fs.utimesSync(file, when, when);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe("git store cache", function () {
  timeout(60 * 1000);

  let dir;
  let caches;

  // Fine-grained recency and no rate limits, so specs can see the order
  const open = (options) => {
    const cache = createCache({ dir, bucketMs: 1, touchEveryMs: 0, walkGapMs: 0, ...options });
    caches.push(cache);
    return cache;
  };

  beforeEach(function () {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "git-store-cache-"));
    caches = [];
  });

  afterEach(async function () {
    await Promise.all(caches.map((cache) => cache.close()));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const data = (length, fill = "x") => Buffer.alloc(length, fill);
  const size = (length) => createCache.entrySize(length);

  it("stores and returns data, and misses what it was never given", async function () {
    const cache = open({ maxBytes: 10000 });
    expect(await cache.get("a")).toBeNull();
    expect(await cache.put("a", Buffer.from("hello"))).toBe(true);
    expect((await cache.get("a")).toString()).toBe("hello");
    expect(await cache.get("b")).toBeNull();
    expect(cache.stats().hits).toBe(1);
    expect(cache.stats().misses).toBe(2);
  });

  it("stores an empty entry", async function () {
    const cache = open({ maxBytes: 10000 });
    await cache.put("empty", Buffer.alloc(0));
    expect((await cache.get("empty")).length).toBe(0);
  });

  it("replaces an entry, leaving one file", async function () {
    const cache = open({ maxBytes: 10000 });
    await cache.put("a", data(100));
    await cache.put("a", data(10, "y"));
    expect((await cache.get("a")).toString()).toBe("yyyyyyyyyy");
    expect(entryFiles(dir).length).toBe(1);
    await cache.settle();
    expect(cache.stats().entryBytes).toBe(size(10));
  });

  it("deletes an entry", async function () {
    const cache = open({ maxBytes: 10000 });
    await cache.put("a", data(10));
    await cache.delete("a");
    expect(await cache.get("a")).toBeNull();
    await cache.settle();
    expect(cache.stats().entryBytes).toBe(0);
  });

  it("leaves no file when a write fails, and forgets the key's old value", async function () {
    const cache = open({ maxBytes: 10000 });
    expect(await cache.put("a", data(24))).toBe(true);

    const fsPromises = require("fs/promises");
    const writeFile = spyOn(fsPromises, "writeFile").and.callFake(async () => {
      throw new Error("disk error");
    });
    expect(await cache.put("a", data(24, "y"))).toBe(false);
    writeFile.and.callThrough();
    expect(await cache.get("a")).toBeNull();
    expect(entryFiles(dir).length).toBe(0);
  });

  describe("ranges and streams", function () {
    it("reads a range, checking only the blocks it spans", async function () {
      const cache = open({ maxBytes: 10 * 1024 * 1024 });
      const bytes = Buffer.from(Array.from({ length: 300 * 1024 }, (_, i) => i % 251));
      await cache.put("pack", bytes);

      expect((await cache.read("pack", 70000, 100)).equals(bytes.subarray(70000, 70100))).toBe(true);
      expect((await cache.read("pack", 0, bytes.length)).equals(bytes)).toBe(true);
      expect((await cache.read("pack", bytes.length - 10, 100)).equals(bytes.subarray(bytes.length - 10))).toBe(true);
      expect(await cache.size("pack")).toBe(bytes.length);

      // A flipped byte in one block fails a read of that block, and the
      // entry is gone
      const [file] = entryFiles(dir);
      const raw = fs.readFileSync(file);
      raw[raw.length - 5] ^= 1;
      fs.writeFileSync(file, raw);
      expect(await cache.read("pack", 0, 100)).not.toBeNull();
      expect(await cache.read("pack", bytes.length - 100, 100)).toBeNull();
      expect(fs.existsSync(file)).toBe(false);
    });

    it("writes a stream as it comes, in chunks across blocks", async function () {
      const cache = open({ maxBytes: 10 * 1024 * 1024 });
      const bytes = Buffer.from(Array.from({ length: 200 * 1024 + 7 }, (_, i) => (i * 7) % 256));
      const chunks = [];
      for (let at = 0; at < bytes.length; at += 10000) chunks.push(bytes.subarray(at, at + 10000));

      expect(await cache.putStream("s", Readable.from(chunks), bytes.length)).toBe(true);
      expect((await cache.get("s")).equals(bytes)).toBe(true);
      expect((await cache.read("s", 65530, 20)).equals(bytes.subarray(65530, 65550))).toBe(true);

      // A stream of the wrong length, or which fails, is not stored
      expect(await cache.putStream("short", Readable.from([data(10)]), 11)).toBe(false);
      expect(await cache.putStream("long", Readable.from([data(12)]), 11)).toBe(false);
      const failing = new Readable({ read() { this.destroy(new Error("gone")); } });
      expect(await cache.putStream("failing", failing, 11)).toBe(false);
      for (const key of ["short", "long", "failing"]) expect(await cache.get(key)).toBeNull();
    });

    it("is a miss when another process deletes the entry before it is read", async function () {
      const cache = open({ maxBytes: 10000 });
      await cache.put("a", data(100));
      expect(await cache.size("a")).toBe(100);
      entryFiles(dir).forEach((file) => fs.rmSync(file));
      expect(await cache.read("a", 0, 10)).toBeNull();
      expect(await cache.get("a")).toBeNull();
      expect(cache.stats().corrupt).toBe(0);
    });

    it("reads an entry whole when it is deleted while open", async function () {
      const cache = open({ maxBytes: 10 * 1024 * 1024 });
      const bytes = data(1024 * 1024, "q");
      await cache.put("a", bytes);
      const [file] = entryFiles(dir);

      const fsPromises = require("fs/promises");
      const real = fsPromises.open;
      spyOn(fsPromises, "open").and.callFake(async (...args) => {
        const handle = await real(...args);
        fs.rmSync(file, { force: true });
        return handle;
      });
      const got = await cache.get("a");
      expect(got.equals(bytes)).toBe(true);
      fsPromises.open.and.callThrough();
      expect(await cache.get("a")).toBeNull();
    });
  });

  describe("pack bytes (packcache.js)", function () {
    const { keepPack, packSource } = require("../packcache");
    const createMemoryStore = require("../objectStore/memory");
    const name = "pack-" + "ab".repeat(20);
    const bytes = Buffer.from(Array.from({ length: 100 * 1024 }, (_, i) => (i * 13) % 256));

    it("reads a kept pack from the cache, and the store once its copy is deleted by another process", async function () {
      const cache = open({ maxBytes: 10 * 1024 * 1024 });
      const store = createMemoryStore();
      await store.put("packs/" + name + ".pack", bytes);

      const file = path.join(dir, "kept.pack");
      fs.writeFileSync(file, bytes);
      expect(await keepPack({ cache, store, name, size: bytes.length, file })).toBe(true);

      const source = packSource({ cache, store, name, size: bytes.length });
      expect(await source.local()).toBe(true);
      const reads = store.stats.reads;
      expect((await source.read(1000, 50)).equals(bytes.subarray(1000, 1050))).toBe(true);
      expect(store.stats.reads).toBe(reads);

      entryFiles(dir).forEach((f) => fs.rmSync(f));
      expect((await source.read(2000, 50)).equals(bytes.subarray(2000, 2050))).toBe(true);
      expect(store.stats.reads).toBe(reads + 1);
    });

    it("keeps no pack bigger than an eighth of the cache, and never fails", async function () {
      const cache = open({ maxBytes: 8 * 1024 });
      const store = createMemoryStore();
      expect(await keepPack({ cache, store, name, size: bytes.length, buffer: bytes })).toBe(false);
      expect(await keepPack({ cache: null, store, name, size: bytes.length, buffer: bytes })).toBe(false);
      expect(await keepPack({ cache: open({ maxBytes: 1e9 }), store, name, size: bytes.length, file: path.join(dir, "missing") })).toBe(false);
    });
  });

  describe("damaged entries", function () {
    for (const [name, damage] of [
      ["truncated", (b) => b.subarray(0, b.length - 3)],
      ["cut to nothing", () => Buffer.alloc(0)],
      ["junk", () => Buffer.from("not a cache entry at all")],
      ["a flipped byte", (b) => Buffer.concat([b.subarray(0, b.length - 1), Buffer.from([b[b.length - 1] ^ 1])])],
      ["extended", (b) => Buffer.concat([b, Buffer.from("more")])],
    ]) {
      it("treats a " + name + " entry as a miss and removes it", async function () {
        const cache = open({ maxBytes: 10000 });
        await cache.put("a", Buffer.from("some cached bytes"));
        const [file] = entryFiles(dir);
        fs.writeFileSync(file, damage(fs.readFileSync(file)));

        expect(await cache.get("a")).toBeNull();
        expect(fs.existsSync(file)).toBe(false);
        expect(cache.stats().corrupt).toBe(1);

        await cache.put("a", Buffer.from("fresh"));
        expect((await cache.get("a")).toString()).toBe("fresh");
      });
    }

    it("never shows a partly written entry to a reader", async function () {
      const cache = open({ maxBytes: 5 * 1024 * 1024 });
      const big = data(2 * 1024 * 1024, "z");
      const write = cache.put("big", big);
      let seen = 0;
      while (!(await Promise.race([write.then(() => true), new Promise((r) => setImmediate(() => r(false)))]))) {
        const got = await cache.get("big");
        if (got) seen += got.length === big.length ? 0 : 1;
      }
      expect(seen).toBe(0);
    });

    it("is merely empty when its directory can't be used", async function () {
      fs.writeFileSync(path.join(dir, "file"), "x");
      const cache = createCache({ dir: path.join(dir, "file", "cache"), maxBytes: 1000 });
      caches.push(cache);
      expect(await cache.get("a")).toBeNull();
      expect(await cache.put("a", data(1))).toBe(false);
      let error;
      await cache.reserve(10).catch((err) => (error = err));
      expect(error).toBeDefined();
    });
  });

  describe("the byte cap", function () {
    it("declines what would go past it, and a walk evicts the least recently used", async function () {
      const cap = 4 * size(24);
      // No walk but the ones the spec runs, so nothing is evicted before the
      // entries are aged
      const cache = open({ maxBytes: cap, highWater: 0.9, lowWater: 0.5, walkGapMs: 1e9 });
      await cache.settle();
      for (const key of ["a", "b", "c", "d"]) expect(await cache.put(key, data(24))).toBe(true);
      const [a, b, c, d] = ["a", "b", "c", "d"].map((key) => fileOf(dir, key));
      age(a, 4000);
      age(b, 3000);
      age(c, 2000);
      age(d, 1000);
      await cache.get("a"); // a is now the most recent

      expect(await cache.put("e", data(24))).toBe(false);
      await cache.settle();
      expect(cache.stats().entryBytes).toBeLessThanOrEqual(cap / 2);
      expect(entryBytes(dir)).toBeLessThanOrEqual(cap / 2);
      expect(await cache.get("b")).toBeNull();
      expect(await cache.get("c")).toBeNull();
      expect(await cache.get("a")).not.toBeNull();
      expect(await cache.get("d")).not.toBeNull();
      expect(await cache.put("e", data(24))).toBe(true);
    });

    it("does not store an entry bigger than the cap, and forgets the key's old value", async function () {
      const cache = open({ maxBytes: 100 });
      await cache.put("a", data(10));
      expect(await cache.put("a", data(200))).toBe(false);
      expect(await cache.get("a")).toBeNull();
      expect(entryBytes(dir)).toBe(0);
    });

    it("works with a cap smaller than any entry", async function () {
      const cache = open({ maxBytes: 8 });
      expect(await cache.put("a", data(1))).toBe(false);
      expect(await cache.get("a")).toBeNull();
      await cache.delete("a");
      await cache.clear();
      expect(entryBytes(dir)).toBe(0);
    });

    it("never goes past it on disk with many writes at once in one process", async function () {
      const cache = open({ maxBytes: 1000 });
      const writes = [];
      for (let i = 0; i < 60; i++) writes.push(cache.put("k" + i, data(10 + (i % 7) * 20)));
      const watcher = setInterval(() => expect(entryBytes(dir)).toBeLessThanOrEqual(1000), 1);
      try {
        await Promise.all(writes);
      } finally {
        clearInterval(watcher);
      }
      expect(entryBytes(dir)).toBeLessThanOrEqual(1000);
    });

    it("picks up a directory another process filled, and evicts what no longer fits a smaller cap", async function () {
      const first = open({ maxBytes: 10000 });
      for (let i = 0; i < 10; i++) await first.put("k" + i, data(84));
      await first.close();

      const second = open({ maxBytes: 4 * size(84) });
      await second.ready();
      // A write during the first's opening walk may be counted twice: the
      // estimate errs high, never low
      expect(second.stats().entryBytes).toBeGreaterThanOrEqual(10 * size(84));
      expect(second.stats().entryBytes).toBeLessThanOrEqual(11 * size(84));
      await second.settle();
      expect(entryBytes(dir)).toBeLessThanOrEqual(4 * size(84));
      expect(second.stats().entryBytes).toBe(entryBytes(dir));
    });

    it("opens a large directory without walking it first", async function () {
      const first = open({ maxBytes: 1e9 });
      await Promise.all(Array.from({ length: 300 }, (_, i) => first.put("k" + i, data(10))));
      await first.close();

      // A walk finds a directory with no usage.json, and opening does not
      // wait for it
      fs.rmSync(path.join(dir, "usage.json"), { force: true });
      const fsPromises = require("fs/promises");
      const lstat = spyOn(fsPromises, "lstat").and.callThrough();
      const second = open({ maxBytes: 1e9 });
      await second.ready();
      const atReady = lstat.calls.count();
      expect(atReady).toBeLessThan(300);
      await second.settle();
      expect(second.stats().entryBytes).toBe(300 * size(10));
    });
  });

  describe("shared by processes", function () {
    it("counts every instance's writes against one budget", async function () {
      const cap = 20 * size(100);
      const a = open({ maxBytes: cap, refreshMs: 0, publishDelayMs: 0 });
      const b = open({ maxBytes: cap, refreshMs: 0, publishDelayMs: 0 });
      await Promise.all([a.ready(), b.ready()]);

      // Each instance alone would store all 30; together the directory never
      // holds more than the cap, while their walks evict to make room
      let declined = 0;
      for (let i = 0; i < 30; i++) {
        declined += (await a.put("a" + i, data(100))) ? 0 : 1;
        expect(entryBytes(dir)).toBeLessThanOrEqual(cap);
        declined += (await b.put("b" + i, data(100))) ? 0 : 1;
        expect(entryBytes(dir)).toBeLessThanOrEqual(cap);
      }
      expect(declined).toBeGreaterThan(0);
      expect(a.stats().walks + b.stats().walks).toBeGreaterThan(0);
      await b.settle();
      await a.settle();
      expect(a.stats().entryBytes).toBe(entryBytes(dir));
      expect(entryBytes(dir)).toBeLessThanOrEqual(cap);
    });

    it("keeps to the budget with child processes writing at once, and one walk at a time evicting", async function () {
      const cap = 200 * 1024;
      const script = path.join(__dirname, "helpers", "cache-writer.js");
      const children = [0, 1, 2].map((n) =>
        fork(script, [dir, String(cap), "p" + n, "200", "2000"], { stdio: ["ignore", "ignore", "inherit", "ipc"] })
      );
      const results = await Promise.all(children.map((child) => new Promise((resolve, reject) => {
        let result = null;
        child.on("message", (message) => (result = message));
        child.on("exit", (code) => (code === 0 ? resolve(result) : reject(new Error("writer exited " + code))));
      })));

      // Writes past the high water mark were declined or asked for walks; at
      // the end the directory is within the cap
      expect(results.reduce((sum, r) => sum + r.stored, 0)).toBeGreaterThan(0);
      expect(results.reduce((sum, r) => sum + r.walks, 0)).toBeGreaterThan(0);
      expect(results.every((r) => r.maxSeen <= cap * 1.1)).toBe(true);

      const cache = open({ maxBytes: cap });
      await cache.settle();
      expect(entryBytes(dir)).toBeLessThanOrEqual(cap);
      expect(fs.existsSync(path.join(dir, "locks", "walk.lock"))).toBe(false);
    });

    it("never lets concurrent large writes in several processes take the same room", async function () {
      for (let round = 0; round < 5; round++) {
        const sub = path.join(dir, "round-" + round);
        const instances = [0, 1, 2].map(() => {
          const cache = createCache({ dir: sub, maxBytes: 1000, bucketMs: 1, touchEveryMs: 0, walkGapMs: 1e9 });
          caches.push(cache);
          return cache;
        });
        await Promise.all(instances.map((cache) => cache.settle()));

        // Each is 400 bytes on disk: any two fit, three do not
        const stored = await Promise.all(instances.map((cache, i) => cache.put("big" + i, data(380))));
        expect(size(380)).toBe(400);
        expect(stored.filter(Boolean).length).toBeLessThanOrEqual(2);
        expect(entryBytes(sub)).toBeLessThanOrEqual(1000);

        // and the same through streams, as packs are written through
        const streamed = await Promise.all(instances.map((cache, i) => cache.putStream("s" + i, Readable.from([data(300)]), 300)));
        expect(entryBytes(sub)).toBeLessThanOrEqual(1000);
        expect(stored.filter(Boolean).length + streamed.filter(Boolean).length).toBeGreaterThan(0);
      }
    });

    it("lets one process walk at a time", async function () {
      const a = open({ maxBytes: 10000 });
      const b = open({ maxBytes: 10000 });
      await Promise.all([a.settle(), b.settle()]);
      const held = await a.lock("walk");
      expect(held).not.toBeNull();
      expect((await b.walk()).walked).toBe(false);
      await held.release();
      expect((await b.walk()).walked).toBe(true);
    });

    it("takes over a walk lock whose holder stopped refreshing it", async function () {
      const a = open({ maxBytes: 10000, walkLockStaleMs: 50 });
      await a.ready();
      fs.writeFileSync(path.join(dir, "locks", "walk.lock"), "someone-deadbeef");
      expect((await a.walk()).walked).toBe(false);
      await sleep(80);
      expect((await a.walk()).walked).toBe(true);
    });
  });

  describe("scratch reservations", function () {
    it("count against the cap, and a walk evicts cached data to make room", async function () {
      const cache = open({ maxBytes: 200 });
      for (const key of ["a", "b", "c"]) await cache.put(key, data(34));
      const reservation = await cache.reserve(120);
      expect(cache.stats().reservedBytes).toBe(120);
      await cache.settle();
      expect(cache.stats().entryBytes + 120).toBeLessThanOrEqual(0.8 * 200);
      expect(await cache.put("d", data(100))).toBe(false);
      await reservation.release();
    });

    it("gives a directory to write into, and deletes it on release", async function () {
      const cache = open({ maxBytes: 1000 });
      const reservation = await cache.reserve(500);
      fs.writeFileSync(path.join(reservation.dir, "incoming.pack"), "pack");
      await reservation.release();
      expect(fs.existsSync(reservation.dir)).toBe(false);
      expect(cache.stats().reservedBytes).toBe(0);
    });

    it("gives back part of a reservation, and no more than it has", async function () {
      const cache = open({ maxBytes: 1000 });
      const reservation = await cache.reserve(300);
      await reservation.extend(400);
      reservation.shrink(500);
      expect(cache.stats().reservedBytes).toBe(200);
      expect(() => reservation.shrink(201)).toThrow();

      const other = await cache.reserve(800);
      await other.release();
      await reservation.release();
      reservation.shrink(1);
      expect(cache.stats().reservedBytes).toBe(0);
    });

    it("fails clearly when the budget isn't there, and changes nothing", async function () {
      const cache = open({ maxBytes: 1000 });
      const first = await cache.reserve(700);
      let error;
      await cache.reserve(400).catch((err) => (error = err));
      expect(error).toEqual(jasmine.any(NoRoomError));
      expect(error.message).toMatch(/Not enough room for 400 bytes/);
      expect(cache.stats().reservedBytes).toBe(700);
      await expectNoRoom(cache.reserve(5000));
      await first.release();
      await (await cache.reserve(900)).release();
    });

    it("can be extended, and fails clearly when the extra isn't there", async function () {
      const cache = open({ maxBytes: 1000 });
      const a = await cache.reserve(400);
      const b = await cache.reserve(400);
      await a.extend(150);
      expect(cache.stats().reservedBytes).toBe(950);
      await expectNoRoom(b.extend(100));
      expect(cache.stats().reservedBytes).toBe(950);
      await a.release();
      await b.release();
      expect(cache.stats().reservedBytes).toBe(0);
    });

    it("are never evicted, and a put can't take room they hold", async function () {
      const cache = open({ maxBytes: 300 });
      const reservation = await cache.reserve(250);
      expect(await cache.put("a", data(100))).toBe(false);
      expect(await cache.put("b", data(20))).toBe(true);
      await cache.settle();
      expect(cache.stats().reservedBytes).toBe(250);
      expect(fs.existsSync(reservation.dir)).toBe(true);
      await reservation.release();
      await cache.settle();
      expect(await cache.put("c", data(100))).toBe(true);
    });

    it("can be released twice", async function () {
      const cache = open({ maxBytes: 1000 });
      const reservation = await cache.reserve(400);
      await reservation.release();
      await reservation.release();
      expect(cache.stats().reservedBytes).toBe(0);
    });

    it("count every process's reservations against one budget", async function () {
      const a = open({ maxBytes: 1000 });
      const b = open({ maxBytes: 1000 });
      const first = await a.reserve(600);
      expect(b.stats().hostReservedBytes).toBeGreaterThanOrEqual(0);
      await expectNoRoom(b.reserve(500));
      const second = await b.reserve(300);
      await a.settle();
      expect(a.stats().hostReservedBytes).toBe(900);
      await first.release();
      await second.release();
    });

    it("never let two processes reserving at once both go past the budget", async function () {
      for (let round = 0; round < 10; round++) {
        const a = open({ maxBytes: 1000 });
        const b = open({ maxBytes: 1000 });
        await Promise.all([a.ready(), b.ready()]);
        const results = await Promise.allSettled([a.reserve(600), b.reserve(600)]);
        const won = results.filter((r) => r.status === "fulfilled");
        expect(won.length).toBeLessThanOrEqual(1);
        for (const r of won) await r.value.release();
        await Promise.all([a.close(), b.close()]);
      }
    });

    it("stop counting, and their scratch is cleared, once their process is gone", async function () {
      const first = open({ maxBytes: 1000, staleMs: 500 });
      const lost = await first.reserve(800);
      fs.writeFileSync(path.join(lost.dir, "incoming.pack"), "half a push");
      await first.close();

      const second = open({ maxBytes: 1000, staleMs: 500 });
      await expectNoRoom(second.reserve(400));
      await sleep(600);
      await second.settle();
      expect(fs.existsSync(lost.dir)).toBe(false);
      expect(second.stats().hostReservedBytes).toBe(0);
      await (await second.reserve(400)).release();
    });
  });

  describe("free space on the disk", function () {
    // A disk of 1000 blocks of 1000 bytes, holding the cache's entries and
    // `other` bytes of something else
    const fakeDisk = (state) => async () => ({ bsize: 1000, blocks: 1000, bavail: Math.floor((1000 * 1000 - state.other - entryBytes(dir)) / 1000) });

    it("declines puts while the disk is under its floor, and a walk evicts to get back over it", async function () {
      const state = { other: 400 * 1000 };
      const cache = open({ maxBytes: 1e9, minFreePercent: 10, statfs: fakeDisk(state), refreshMs: 0 });
      for (let i = 0; i < 10; i++) expect(await cache.put("k" + i, data(10000))).toBe(true);
      for (let i = 0; i < 10; i++) age(fileOf(dir, "k" + i), 10000 - i * 100);

      // The disk fills up from something else: under 5% free
      state.other = 860 * 1000;
      expect(await cache.put("more", data(10))).toBe(false);

      // The walk frees what takes the disk back over 10%, and a point more,
      // oldest first, and not everything
      await cache.settle();
      expect(cache.stats().evictions).toBeGreaterThanOrEqual(6);
      expect((await fakeDisk(state)()).bavail * 1000).toBeGreaterThanOrEqual(100 * 1000);
      expect(entryFiles(dir).length).toBeGreaterThan(0);
      expect(await cache.get("k0")).toBeNull();
      expect(await cache.get("k9")).not.toBeNull();
    });

    it("refuses a reservation which would take the disk under its floor", async function () {
      const state = { other: 850 * 1000 };
      const cache = open({ maxBytes: 1e9, minFreePercent: 10, statfs: fakeDisk(state) });
      const ok = await cache.reserve(40 * 1000);
      let error;
      await cache.reserve(60 * 1000).catch((err) => (error = err));
      expect(error).toEqual(jasmine.any(NoRoomError));
      expect(error.message).toMatch(/keeps 10% of it free/);
      expect(cache.stats().reservedBytes).toBe(40 * 1000);
      await ok.release();

      state.other = 0;
      await (await cache.reserve(60 * 1000)).release();
    });

    it("counts every process's reservations not yet written against the floor", async function () {
      // 150,000 free and a floor of 100,000: room for one of these, not two,
      // though neither has written anything yet
      const state = { other: 850 * 1000 };
      // Writes of 32 KB and more are claimed as reservations are
      const a = open({ maxBytes: 1e9, minFreePercent: 10, statfs: fakeDisk(state), claimWritesFrom: 32 * 1024 });
      const b = open({ maxBytes: 1e9, minFreePercent: 10, statfs: fakeDisk(state), claimWritesFrom: 32 * 1024 });
      const first = await a.reserve(40 * 1000);

      let error;
      await b.reserve(40 * 1000).catch((err) => (error = err));
      expect(error).toEqual(jasmine.any(NoRoomError));
      expect(error.message).toMatch(/keeps 10% of it free/);

      await first.release();
      await (await b.reserve(40 * 1000)).release();

      // A large write in flight counts too, from the moment it is admitted
      // (the source is first read once the write has its room)
      let admitted;
      const reading = new Promise((resolve) => (admitted = resolve));
      const source = new Readable({ read: () => admitted() });
      const write = a.putStream("big", source, 40 * 1000);
      await reading;
      await expectNoRoom(b.reserve(40 * 1000));
      source.push(data(40 * 1000));
      source.push(null);
      expect(await write).toBe(true);
    });
  });

  describe("lock files and notes", function () {
    it("gives a lock to one holder until it is released", async function () {
      const a = open({ maxBytes: 1000 });
      const b = open({ maxBytes: 1000 });
      const held = await a.lock("warm", { staleMs: 60000 });
      expect(held).not.toBeNull();
      expect(await b.lock("warm", { staleMs: 60000 })).toBeNull();
      await held.release();
      const next = await b.lock("warm", { staleMs: 60000 });
      expect(next).not.toBeNull();
      await next.release();
    });

    it("keeps a note", async function () {
      const a = open({ maxBytes: 1000 });
      expect(await a.readNote("warm")).toBeNull();
      await a.writeNote("warm", { at: 5 });
      const b = open({ maxBytes: 1000 });
      expect(await b.readNote("warm")).toEqual({ at: 5 });
    });
  });

  async function expectNoRoom(promise) {
    let error;
    await promise.catch((err) => (error = err));
    expect(error).toEqual(jasmine.any(NoRoomError));
  }
});
