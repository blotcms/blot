const fs = require("fs");
const os = require("os");
const path = require("path");
const createCache = require("../cache");
const timeout = require("./helpers/timeout");
const { NoRoomError } = require("../errors");

function diskBytes(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    try {
      if (entry.isFile()) total += fs.statSync(path.join(entry.parentPath, entry.name)).size;
    } catch (err) {
      // deleted while we were counting
    }
  }
  return total;
}

function files(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name));
}

describe("git store cache", function () {
  timeout(30 * 1000);

  let dir;

  beforeEach(function () {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "git-store-cache-"));
  });

  afterEach(function () {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // Each entry costs its data plus a 16-byte header
  const data = (length, fill = "x") => Buffer.alloc(length, fill);

  it("stores and returns data, and misses what it was never given", async function () {
    const cache = createCache({ dir, maxBytes: 10000 });
    expect(await cache.get("a")).toBeNull();
    expect(await cache.put("a", Buffer.from("hello"))).toBe(true);
    expect((await cache.get("a")).toString()).toBe("hello");
    expect(await cache.get("b")).toBeNull();
    expect(cache.stats().hits).toBe(1);
    expect(cache.stats().misses).toBe(2);
  });

  it("stores an empty entry", async function () {
    const cache = createCache({ dir, maxBytes: 10000 });
    await cache.put("empty", Buffer.alloc(0));
    expect((await cache.get("empty")).length).toBe(0);
  });

  it("replaces an entry", async function () {
    const cache = createCache({ dir, maxBytes: 10000 });
    await cache.put("a", data(100));
    await cache.put("a", data(10, "y"));
    expect((await cache.get("a")).toString()).toBe("yyyyyyyyyy");
    expect(cache.stats().entryBytes).toBe(26);
  });

  it("deletes an entry", async function () {
    const cache = createCache({ dir, maxBytes: 10000 });
    await cache.put("a", data(10));
    await cache.delete("a");
    expect(await cache.get("a")).toBeNull();
    expect(cache.stats().entryBytes).toBe(0);
  });

  describe("the byte cap", function () {
    it("evicts the least recently used entries to stay within it", async function () {
      const cache = createCache({ dir, maxBytes: 100 });
      await cache.put("a", data(24)); // 40 bytes each
      await cache.put("b", data(24));
      await cache.get("a"); // b is now the least recent
      await cache.put("c", data(24));

      expect(await cache.get("b")).toBeNull();
      expect(await cache.get("a")).not.toBeNull();
      expect(await cache.get("c")).not.toBeNull();
      expect(cache.stats().entryBytes).toBeLessThanOrEqual(100);
      expect(diskBytes(dir)).toBeLessThanOrEqual(100);
    });

    it("does not store an entry bigger than the cap, and forgets the key's old value", async function () {
      const cache = createCache({ dir, maxBytes: 100 });
      await cache.put("a", data(10));
      expect(await cache.put("a", data(200))).toBe(false);
      expect(await cache.get("a")).toBeNull();
      expect(diskBytes(dir)).toBe(0);
    });

    it("works with a cap smaller than any entry", async function () {
      const cache = createCache({ dir, maxBytes: 8 });
      expect(await cache.put("a", data(1))).toBe(false);
      expect(await cache.get("a")).toBeNull();
      await cache.delete("a");
      await cache.clear();
      expect(diskBytes(dir)).toBe(0);
    });

    it("never exceeds the cap on disk with many writes at once", async function () {
      const cache = createCache({ dir, maxBytes: 1000 });
      const writes = [];
      for (let i = 0; i < 60; i++) writes.push(cache.put("k" + (i % 25), data(10 + (i % 7) * 20)));
      const watcher = setInterval(() => {
        expect(diskBytes(dir)).toBeLessThanOrEqual(1000);
      }, 1);
      try {
        await Promise.all(writes);
      } finally {
        clearInterval(watcher);
      }

      expect(cache.stats().entryBytes).toBeLessThanOrEqual(1000);
      expect(diskBytes(dir)).toBeLessThanOrEqual(1000);
    });
  });

  describe("entries which vanish or are damaged", function () {
    it("treats a deleted file as a miss", async function () {
      const cache = createCache({ dir, maxBytes: 10000 });
      await cache.put("a", data(10));
      files(dir).forEach((file) => fs.rmSync(file));
      expect(await cache.get("a")).toBeNull();
      expect(cache.stats().entryBytes).toBe(0);
    });

    for (const [name, damage] of [
      ["truncated", (b) => b.subarray(0, b.length - 3)],
      ["cut to nothing", () => Buffer.alloc(0)],
      ["junk", () => Buffer.from("not a cache entry at all")],
      ["a flipped byte", (b) => Buffer.concat([b.subarray(0, b.length - 1), Buffer.from([b[b.length - 1] ^ 1])])],
      ["extended", (b) => Buffer.concat([b, Buffer.from("more")])],
    ]) {
      it("treats a " + name + " entry as a miss and removes it", async function () {
        const cache = createCache({ dir, maxBytes: 10000 });
        await cache.put("a", Buffer.from("some cached bytes"));
        const [file] = files(dir);
        fs.writeFileSync(file, damage(fs.readFileSync(file)));

        expect(await cache.get("a")).toBeNull();
        expect(fs.existsSync(file)).toBe(false);
        expect(cache.stats().corrupt).toBe(1);
        expect(cache.stats().entryBytes).toBe(0);

        // and can be stored again
        await cache.put("a", Buffer.from("fresh"));
        expect((await cache.get("a")).toString()).toBe("fresh");
      });
    }

    it("clears half-written temporary files left by an earlier process", async function () {
      fs.mkdirSync(path.join(dir, "tmp"), { recursive: true });
      fs.writeFileSync(path.join(dir, "tmp", "abc.123.1"), data(500));
      const cache = createCache({ dir, maxBytes: 10000 });
      await cache.ready();
      expect(fs.existsSync(path.join(dir, "tmp"))).toBe(false);
    });

    it("never shows a partly written entry to a reader", async function () {
      const cache = createCache({ dir, maxBytes: 5 * 1024 * 1024 });
      const big = data(2 * 1024 * 1024, "z");
      const write = cache.put("big", big);
      let seen = 0;
      while (!(await Promise.race([write.then(() => true), new Promise((r) => setImmediate(() => r(false)))]))) {
        const got = await cache.get("big");
        if (got) seen += got.length === big.length ? 0 : 1;
      }
      expect(seen).toBe(0);
    });

    it("picks up where it left off when reopened, oldest first", async function () {
      const first = createCache({ dir, maxBytes: 10000 });
      await first.put("a", data(24));
      await new Promise((r) => setTimeout(r, 20));
      await first.put("b", data(24));

      const second = createCache({ dir, maxBytes: 90 });
      await second.ready();
      expect(second.stats().entryBytes).toBe(80);
      await second.put("c", data(24));
      expect(await second.get("a")).toBeNull();
      expect(await second.get("b")).not.toBeNull();
    });

    it("drops what no longer fits when reopened with a smaller cap", async function () {
      const first = createCache({ dir, maxBytes: 10000 });
      for (let i = 0; i < 10; i++) await first.put("k" + i, data(84)); // 100 each
      const second = createCache({ dir, maxBytes: 350 });
      await second.ready();
      expect(second.stats().entryBytes).toBeLessThanOrEqual(350);
      expect(diskBytes(dir)).toBeLessThanOrEqual(350);
    });

    it("is merely empty when its directory can't be used", async function () {
      fs.writeFileSync(path.join(dir, "file"), "x");
      const cache = createCache({ dir: path.join(dir, "file", "cache"), maxBytes: 1000 });
      expect(await cache.get("a")).toBeNull();
      expect(await cache.put("a", data(1))).toBe(false);
      let error;
      await cache.reserve(10).catch((err) => (error = err));
      expect(error).toBeDefined();
    });
  });

  describe("scratch reservations", function () {
    it("evicts cached data to make room", async function () {
      const cache = createCache({ dir, maxBytes: 200 });
      await cache.put("a", data(34)); // 50 each
      await cache.put("b", data(34));
      await cache.put("c", data(34));

      const reservation = await cache.reserve(120);
      expect(cache.stats().reservedBytes).toBe(120);
      expect(cache.stats().entryBytes).toBeLessThanOrEqual(80);
      expect(await cache.get("a")).toBeNull();
      await reservation.release();
    });

    it("gives a directory to write into, and deletes it on release", async function () {
      const cache = createCache({ dir, maxBytes: 1000 });
      const reservation = await cache.reserve(500);
      fs.writeFileSync(path.join(reservation.dir, "incoming.pack"), "pack");
      expect(fs.existsSync(reservation.dir)).toBe(true);

      await reservation.release();
      expect(fs.existsSync(reservation.dir)).toBe(false);
      expect(cache.stats().reservedBytes).toBe(0);
    });

    it("fails clearly when the budget isn't there, and changes nothing", async function () {
      const cache = createCache({ dir, maxBytes: 1000 });
      await cache.put("a", data(34));
      const first = await cache.reserve(700);

      let error;
      await cache.reserve(400).catch((err) => (error = err));
      expect(error).toEqual(jasmine.any(NoRoomError));
      expect(error.message).toMatch(/Not enough room for 400 bytes/);
      expect(cache.stats().reservedBytes).toBe(700);

      await expectAsyncRejects(cache.reserve(5000));
      await first.release();
      const second = await cache.reserve(900);
      await second.release();
    });

    it("keeps reservations out of the cache's reach: they are not evicted", async function () {
      const cache = createCache({ dir, maxBytes: 300 });
      const reservation = await cache.reserve(250);
      expect(await cache.put("a", data(100))).toBe(false); // more than the 50 left
      expect(await cache.put("b", data(20))).toBe(true); // 36 bytes fit
      expect(cache.stats().reservedBytes).toBe(250);
      await reservation.release();
      expect(await cache.put("c", data(100))).toBe(true);
    });

    it("can be extended, and fails clearly when the extra isn't there", async function () {
      const cache = createCache({ dir, maxBytes: 1000 });
      const a = await cache.reserve(400);
      const b = await cache.reserve(400);

      await a.extend(150);
      expect(cache.stats().reservedBytes).toBe(950);

      let error;
      await b.extend(100).catch((err) => (error = err));
      expect(error).toEqual(jasmine.any(NoRoomError));
      expect(cache.stats().reservedBytes).toBe(950);

      await a.release();
      await b.release();
      expect(cache.stats().reservedBytes).toBe(0);
    });

    it("can be released twice", async function () {
      const cache = createCache({ dir, maxBytes: 1000 });
      const reservation = await cache.reserve(400);
      await reservation.release();
      await reservation.release();
      expect(cache.stats().reservedBytes).toBe(0);
    });

    it("clears scratch space an earlier process left behind", async function () {
      const first = createCache({ dir, maxBytes: 1000 });
      const lost = await first.reserve(400);
      fs.writeFileSync(path.join(lost.dir, "incoming.pack"), "half a push");

      const second = createCache({ dir, maxBytes: 1000 });
      await second.ready();
      expect(fs.existsSync(lost.dir)).toBe(false);
      expect(second.stats().reservedBytes).toBe(0);
    });
  });

  async function expectAsyncRejects(promise) {
    let error;
    await promise.catch((err) => (error = err));
    expect(error).toEqual(jasmine.any(NoRoomError));
  }
});
