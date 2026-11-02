// Reads objects out of packs made by real git, by range, and compares every
// one with what `git cat-file` says it is.
const fx = require("./helpers/fixture");
const timeout = require("./helpers/timeout");
const createReader = require("../reader");
const createCache = require("../cache");
const createMemoryStore = require("../objectStore/memory");
const { CorruptError, TooLargeError } = require("../errors");

async function collect(iterable) {
  const chunks = [];
  for await (const chunk of iterable) chunks.push(chunk);
  return Buffer.concat(chunks);
}

describe("git store reader", function () {
  timeout(60 * 1000);

  let workDir;
  let fixture;
  let oracle; // Map(oid -> { type, data }) from git itself

  beforeAll(function () {
    workDir = fx.tempDir();
    fixture = fx.buildFixture(workDir + "/repo");
    oracle = fx.catAll(fixture.dir);
  });

  afterAll(function () {
    fx.remove(workDir);
  });

  // Puts packs in a store, and returns a reader over them (oldest first)
  async function readerFor(packs, { store = createMemoryStore(), cache = null, maxSize } = {}) {
    const entries = [];
    for (const pack of packs) entries.push(await fx.upload(store, pack, pack.objects || 0));
    return { store, reader: createReader({ store, cache, packs: entries, maxSize }) };
  }

  async function expectAllObjects(reader, expected = oracle) {
    for (const [oid, want] of expected) {
      const got = await reader.read(oid);
      expect(got.type).toBe(want.type);
      expect(got.size).toBe(want.data.length);
      if (!got.data.equals(want.data)) fail("Object " + oid + " differs from git cat-file");
    }
  }

  it("has a fixture with commits, trees, blobs and a tag", function () {
    const types = new Set([...oracle.values()].map((o) => o.type));
    expect([...types].sort()).toEqual(["blob", "commit", "tag", "tree"]);
    expect(oracle.size).toBeGreaterThan(200);
  });

  describe("one pack with OFS_DELTA entries", function () {
    let packs;

    beforeAll(function () {
      fx.repackAll(fixture.dir);
      packs = fx.readPacks(fixture.dir);
    });

    it("has delta chains for the specs to resolve", function () {
      expect(packs.length).toBe(1);
      const entries = fx.listEntries(packs[0]);
      expect(Math.max(...entries.map((e) => e.depth))).toBeGreaterThan(2);
    });

    it("reads every object as git does", async function () {
      const { reader } = await readerFor(packs);
      await expectAllObjects(reader);
    });

    it("tells the type of every object, through delta chains, from entry headers only", async function () {
      const { reader } = await readerFor(packs);
      for (const [oid, want] of oracle) expect(await reader.typeOf(oid)).toBe(want.type);
      expect(await reader.typeOf("1".repeat(40))).toBeNull();
    });

    it("reads every object with a cache, cold then warm", async function () {
      const cache = createCache({ dir: workDir + "/cache-a", maxBytes: 50 * 1024 * 1024 });
      const { reader } = await readerFor(packs, { cache });
      await expectAllObjects(reader);
      await expectAllObjects(reader);
      expect(cache.stats().hits).toBeGreaterThan(0);
    });

    it("reads every object with a cache far too small for the index", async function () {
      const cache = createCache({ dir: workDir + "/cache-b", maxBytes: 100 });
      const { reader } = await readerFor(packs, { cache });
      await expectAllObjects(reader);
      expect(cache.stats().entryBytes).toBeLessThanOrEqual(100);
    });

    it("says an object is absent, and finds present ones", async function () {
      const { reader } = await readerFor(packs);
      expect(await reader.has(fixture.head)).toBe(true);
      expect(await reader.has("1".repeat(40))).toBe(false);
      expect(await reader.read("1".repeat(40))).toBeNull();
      expect(await reader.stream("1".repeat(40))).toBeNull();
    });

    it("reads an object in few round trips, and the next near it in fewer", async function () {
      const cache = createCache({ dir: workDir + "/cache-c", maxBytes: 50 * 1024 * 1024 });
      const { store, reader } = await readerFor(packs, { cache });
      const commit = fx.listEntries(packs[0]).find((e) => e.type === "commit" && e.depth === 0);
      const before = store.stats.reads;

      await reader.read(commit.oid);
      const first = store.stats.reads - before;
      expect(first).toBeLessThanOrEqual(5);

      // The same commit again needs only its own bytes
      const second = store.stats.reads;
      await reader.read(commit.oid);
      expect(store.stats.reads - second).toBeLessThanOrEqual(1);
    });

    it("streams an object stored whole in small chunks", async function () {
      const large = [...oracle].find(([, o]) => o.type === "blob" && o.data.length === 3 * 1024 * 1024);
      const { store, reader } = await readerFor(packs);

      const got = await reader.stream(large[0]);
      expect(got.size).toBe(3 * 1024 * 1024);

      let biggest = 0;
      const chunks = [];
      for await (const chunk of got.data) {
        biggest = Math.max(biggest, chunk.length);
        chunks.push(chunk);
      }
      expect(Buffer.concat(chunks).equals(large[1].data)).toBe(true);
      expect(biggest).toBeLessThanOrEqual(64 * 1024);

      // Reads grow, so it isn't a request per 64 KB
      expect(store.stats.reads).toBeLessThan(40);
    });

    it("refuses an object bigger than the limit it was given", async function () {
      const large = [...oracle].find(([, o]) => o.data.length === 3 * 1024 * 1024);
      const { reader } = await readerFor(packs);

      let error;
      await reader.read(large[0], { maxSize: 1024 * 1024 }).catch((err) => (error = err));
      expect(error instanceof TooLargeError).toBe(true);
    });

    it("limits a delta chain's result too", async function () {
      const { reader } = await readerFor(packs, { maxSize: 200 });
      const deltified = fx.listEntries(packs[0]).find((e) => e.depth > 0 && e.size > 200);

      let error;
      await reader.read(deltified.oid).catch((err) => (error = err));
      expect(error instanceof TooLargeError).toBe(true);
    });
  });

  describe("one pack with REF_DELTA entries", function () {
    it("reads every object as git does", async function () {
      fx.repackAll(fixture.dir, { refDeltas: true });
      const packs = fx.readPacks(fixture.dir);
      expect(fx.listEntries(packs[0]).some((e) => e.depth > 0)).toBe(true);

      const { reader } = await readerFor(packs);
      await expectAllObjects(reader);
    });
  });

  describe("several packs", function () {
    let early;
    let thin;
    let fixed;
    let late;
    let everything;

    beforeAll(function () {
      const [c10, c20, c30] = [fixture.commits[9], fixture.commits[19], fixture.commits[29]];

      early = fx.indexPack(fx.packRevs(fixture.dir, [c10]));

      // What a push of c10..c20 sends: deltas against objects it leaves out
      const thinPack = fx.packRevs(fixture.dir, [c20], [c10], { thin: true });
      fixed = fx.fixThin(thinPack, [early]);
      thin = fx.cutThin(fixed, thinPack.readUInt32BE(8));

      late = fx.indexPack(fx.packRevs(fixture.dir, [c30, fixture.tag], [c20]));
      everything = fx.indexPack(fx.packRevs(fixture.dir, [c30, fixture.tag]));
    });

    it("has a thin pack with deltas on objects it does not hold", function () {
      expect(fx.listEntries(fixed).length).toBeGreaterThan(thin.entries.length);
    });

    it("resolves REF_DELTA entries whose base is in another pack", async function () {
      const { reader } = await readerFor([early, thin, late]);
      await expectAllObjects(reader);
    });

    it("cannot resolve them without that other pack, and says so", async function () {
      const { reader } = await readerFor([thin]);
      let failures = 0;
      for (const { oid } of thin.entries) {
        await reader.read(oid).catch(() => failures++);
      }
      expect(failures).toBeGreaterThan(0);
    });

    it("reads a thin-fixed pack, which repeats objects other packs hold", async function () {
      const { reader } = await readerFor([early, fixed, late]);
      await expectAllObjects(reader);
    });

    it("reads objects held by several packs, taking the newest copy", async function () {
      const { store, reader } = await readerFor([early, fixed, late, everything]);
      await expectAllObjects(reader);

      const at = await reader.locate(fixture.commits[2]);
      expect(at.pack.name).toBe(everything.name);
      expect(store.stats.reads).toBeGreaterThan(0);
    });

    it("reads an index which uses the table of 8-byte offsets", async function () {
      const entries = fx.listEntries(early);
      const idx = fx.buildIdx(entries, early.pack, { largeFrom: 5000 });
      expect(idx.length).toBeGreaterThan(early.idx.length);

      const { reader } = await readerFor([{ ...early, idx }]);
      const expected = new Map(entries.map((e) => [e.oid, oracle.get(e.oid)]));
      await expectAllObjects(reader, expected);
    });
  });

  describe("damaged data", function () {
    let packs;

    beforeAll(function () {
      fx.repackAll(fixture.dir);
      packs = fx.readPacks(fixture.dir);
    });

    async function expectCorrupt(promise) {
      let error;
      await promise.catch((err) => (error = err));
      expect(error).toEqual(jasmine.any(CorruptError));
    }

    function wholeBlob(minSize) {
      return fx.listEntries(packs[0]).find((e) => e.type === "blob" && e.depth === 0 && e.size > minSize);
    }

    it("rejects a flipped byte in an entry", async function () {
      const target = wholeBlob(500);
      const pack = Buffer.from(packs[0].pack);
      pack[target.offset + 12] ^= 0x55;

      const { reader } = await readerFor([{ ...packs[0], pack }]);
      await expectCorrupt(reader.read(target.oid));
    });

    it("rejects a flipped byte when streaming", async function () {
      const target = wholeBlob(500);
      const pack = Buffer.from(packs[0].pack);
      pack[target.offset + 12] ^= 0x55;

      const { reader } = await readerFor([{ ...packs[0], pack }]);
      await expectCorrupt(reader.stream(target.oid).then((got) => collect(got.data)));
    });

    it("rejects a pack cut short", async function () {
      const target = fx.listEntries(packs[0]).find((e) => e.type === "blob" && e.size > 100000);
      const store = createMemoryStore();
      const entry = await fx.upload(store, packs[0], 0);
      const cut = packs[0].pack.subarray(0, target.offset + 200);
      await store.put("packs/" + packs[0].name + ".pack", Buffer.concat([cut, Buffer.alloc(20)]));
      const reader = createReader({ store, packs: [{ ...entry, size: cut.length + 20 }] });

      await expectCorrupt(reader.read(target.oid));
    });

    it("rejects an index which points at the wrong place", async function () {
      const entries = fx.listEntries(packs[0]).filter((e) => e.depth === 0);
      const [a, b] = [entries[3], entries[4]];
      const swapped = fx.buildIdx(
        fx.listEntries(packs[0]).map((e) => (e.oid === a.oid ? { ...e, offset: b.offset } : e)),
        packs[0].pack
      );

      const { reader } = await readerFor([{ ...packs[0], idx: swapped }]);
      await expectCorrupt(reader.read(a.oid));
    });

    it("rejects an index which is not one", async function () {
      const idx = Buffer.from(packs[0].idx);
      idx[1] ^= 0xff;
      const { reader } = await readerFor([{ ...packs[0], idx }]);
      await expectCorrupt(reader.read(fixture.head));
    });

    it("rejects an index shorter than its fanout says", async function () {
      const { reader } = await readerFor([{ ...packs[0], idx: packs[0].idx.subarray(0, 2000) }]);
      await expectCorrupt(reader.read(fixture.head));
    });

    it("rejects an offset outside the pack", async function () {
      const entries = fx.listEntries(packs[0]).map((e, i) => (i === 5 ? { ...e, offset: packs[0].pack.length + 100 } : e));
      const idx = fx.buildIdx(entries, packs[0].pack);
      const { reader } = await readerFor([{ ...packs[0], idx }]);
      await expectCorrupt(reader.read(entries[5].oid));
    });

    it("ignores a damaged cache entry and reads again", async function () {
      const fs = require("fs");
      const path = require("path");
      const dir = workDir + "/cache-d";
      const cache = createCache({ dir, maxBytes: 10 * 1024 * 1024 });
      const { reader } = await readerFor(packs, { cache });
      await expectAllObjects(reader);

      // Damage every file in the cache
      for (const shard of fs.readdirSync(path.join(dir, "entries"))) {
        for (const name of fs.readdirSync(path.join(dir, "entries", shard))) {
          fs.writeFileSync(path.join(dir, "entries", shard, name), "junk");
        }
      }

      await expectAllObjects(reader);
      expect(cache.stats().corrupt).toBeGreaterThan(0);
    });
  });

});
