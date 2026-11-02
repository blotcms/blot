// The store against an object store which fails the way a network does: a
// response lost after the write landed, a body cut short, a stale answer, a
// process which dies between uploads. See helpers/faults.js for what can be
// injected.
const fx = require("./helpers/fixture");
const faults = require("./helpers/faults");
const timeout = require("./helpers/timeout");
const manifest = require("../manifest");
const createMemoryStore = require("../objectStore/memory");
const createReader = require("../reader");
const createCache = require("../cache");
const { CorruptError, StaleManifestError, OutcomeUnknownError } = require("../errors");
const { LATEST_KEY, manifestKey } = require("../layout");

const oid = (n) => String(n).repeat(40).slice(0, 40);
const packName = (n) => "pack-" + oid(n);

function packEntry(n) {
  return { name: packName(n), size: 1000 + n, idxSize: 500 + n, objects: 10 + n };
}

const lock = (fn) => fn();

async function uploaded(store, ...entries) {
  for (const entry of entries) {
    await store.put("packs/" + entry.name + ".pack", Buffer.alloc(entry.size));
    await store.put("packs/" + entry.name + ".idx", Buffer.alloc(entry.idxSize));
  }
}

async function fails(promise) {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  return null;
}

async function collect(iterable) {
  const chunks = [];
  for await (const chunk of iterable) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

// What the AWS SDK throws when the connection drops, and when S3 refuses
const dropped = () => Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
const refused = (status) => Object.assign(new Error("HTTP " + status), { $metadata: { httpStatusCode: status } });

describe("git store against a misbehaving object store", function () {
  timeout(60 * 1000);

  describe("the fault-injecting store", function () {
    let store;

    beforeEach(async function () {
      store = faults(createMemoryStore());
      await store.put("k", Buffer.from("0123456789"));
    });

    it("applies the call and then throws, for an error after success", async function () {
      store.inject("put", { after: dropped() });
      expect((await fails(store.put("j", Buffer.from("x")))).code).toBe("ECONNRESET");
      expect((await store.get("j")).toString()).toBe("x");
    });

    it("throws without applying, for an error before", async function () {
      store.inject("put", { before: dropped() });
      expect((await fails(store.put("j", Buffer.from("x")))).code).toBe("ECONNRESET");
      expect(await store.head("j")).toBeNull();
    });

    it("applies the call and answers something else", async function () {
      store.inject("putIfAbsent", { result: false });
      expect(await store.putIfAbsent("j", Buffer.from("x"))).toBe(false);
      expect((await store.get("j")).toString()).toBe("x");
    });

    it("cuts a read, a get and a stream short", async function () {
      store.inject("read", { truncate: 3 }).inject("get", { truncate: (b) => b.length - 1 }).inject("stream", { truncate: 4 });
      expect((await store.read("k", 0, 10)).toString()).toBe("012");
      expect((await store.get("k")).toString()).toBe("012345678");
      expect((await collect(store.stream("k"))).toString()).toBe("0123");
    });

    it("fails a stream after its truncated body", async function () {
      store.inject("stream", { truncate: 4, after: dropped() });
      const chunks = [];
      let error;
      try {
        for await (const chunk of store.stream("k")) chunks.push(chunk);
      } catch (err) {
        error = err;
      }
      expect(Buffer.concat(chunks).toString()).toBe("0123");
      expect(error.code).toBe("ECONNRESET");
    });

    it("answers a stale value, or throws it", async function () {
      store.inject("head", { answer: null }).inject("get", { answer: Buffer.from("old") });
      expect(await store.head("k")).toBeNull();
      expect((await store.get("k")).toString()).toBe("old");
      store.inject("read", { answer: dropped() });
      expect((await fails(store.read("k", 0, 1))).code).toBe("ECONNRESET");
    });

    it("delays a call", async function () {
      store.inject("head", { delay: 30 });
      const started = Date.now();
      expect((await store.head("k")).size).toBe(10);
      expect(Date.now() - started).toBeGreaterThanOrEqual(25);
    });

    it("applies a fault to the keys and calls it was set for, the number of times asked", async function () {
      store.inject("read", { key: "k", skip: 1, times: 2, truncate: 1 });
      store.inject("read", { key: /^other/, truncate: 0 });
      await store.put("other", Buffer.from("abc"));

      expect((await store.read("k", 0, 10)).length).toBe(10); // skipped
      expect((await store.read("other", 0, 10)).length).toBe(0);
      expect((await store.read("k", 0, 10)).length).toBe(1);
      expect((await store.read("k", 0, 10)).length).toBe(1);
      expect((await store.read("k", 0, 10)).length).toBe(10); // used up
      expect(store.pending()).toBe(0);
    });

    it("lists its calls and passes the wrapped store's id and stats through", async function () {
      await store.read("k", 0, 1);
      expect(store.calls.slice(-1)).toEqual(["read k"]);
      expect(store.id).toMatch(/^memory:/);
      expect(store.stats.reads).toBe(1);
    });
  });

  describe("an ambiguous swap", function () {
    let store;
    let base;

    beforeEach(async function () {
      store = faults(createMemoryStore());
      const entry = packEntry(1);
      await uploaded(store, entry);
      base = manifest.advance(manifest.empty(), { refs: { "refs/heads/master": oid(1) }, packs: [entry] });
      await manifest.swap({ store, lock, base: manifest.empty(), next: base });
      store.calls.length = 0;
    });

    async function push(from, n) {
      const entry = packEntry(n);
      await uploaded(store, entry);
      return manifest.advance(from, { refs: { "refs/heads/master": oid(n) }, packs: [entry] });
    }

    const manifestGets = () => store.calls.filter((call) => call === "get " + manifestKey(2));

    it("gives each manifest it advances a nonce of its own", async function () {
      const a = await push(base, 2);
      const b = await push(base, 3);
      expect(a.writer).toMatch(/^[0-9a-f]{32}$/);
      expect(a.writer).not.toBe(b.writer);
      expect(a.writer).not.toBe(base.writer);
    });

    it("succeeds when the create landed but its response was lost", async function () {
      const next = await push(base, 2);
      store.inject("putIfAbsent", { key: manifestKey(2), after: dropped() });

      expect(await manifest.swap({ store, lock, base, next })).toEqual(next);
      expect(await manifest.read(store)).toEqual(next);
      expect(manifestGets().length).toBe(1);
    });

    it("succeeds when a retry of the create found its own earlier write and answered false", async function () {
      const next = await push(base, 2);
      store.inject("putIfAbsent", { key: manifestKey(2), result: false });

      expect(await manifest.swap({ store, lock, base, next })).toEqual(next);
      expect((await manifest.read(store)).writer).toBe(next.writer);
    });

    it("succeeds when a server error came after the write", async function () {
      const next = await push(base, 2);
      store.inject("putIfAbsent", { key: manifestKey(2), after: refused(503) });
      expect(await manifest.swap({ store, lock, base, next })).toEqual(next);
    });

    it("still writes the hint and remembers the manifest after a confirmed swap", async function () {
      const next = await push(base, 2);
      store.inject("putIfAbsent", { key: manifestKey(2), after: dropped() });
      await manifest.swap({ store, lock, base, next });

      expect(JSON.parse(await store.get(LATEST_KEY))).toEqual({ seq: 2 });
      store.calls.length = 0;
      expect(await manifest.read(store)).toEqual(next);
      expect(manifestGets().length).toBe(0);
    });

    it("throws StaleManifestError for a true lost race, and leaves the winner's manifest", async function () {
      const mine = await push(base, 2);
      const theirs = await push(base, 3);
      await manifest.swap({ store, lock, base, next: theirs });

      // The early look at the manifest missed theirs, so the create is what loses
      store.inject("head", { key: manifestKey(2), answer: null });
      const error = await fails(manifest.swap({ store, lock, base, next: mine }));

      expect(error).toEqual(jasmine.any(StaleManifestError));
      expect(await manifest.read(store)).toEqual(theirs);
      expect(manifestGets().length).toBe(1);
    });

    it("throws StaleManifestError when an unknown outcome turns out to be someone else's manifest", async function () {
      const mine = await push(base, 2);
      const theirs = await push(base, 3);
      await manifest.swap({ store, lock, base, next: theirs });

      store.inject("head", { key: manifestKey(2), answer: null });
      store.inject("putIfAbsent", { key: manifestKey(2), before: dropped() });
      expect(await fails(manifest.swap({ store, lock, base, next: mine }))).toEqual(jasmine.any(StaleManifestError));
    });

    it("throws StaleManifestError for a base which has moved on, without being fooled by it", async function () {
      const mine = await push(base, 2);
      await manifest.swap({ store, lock, base, next: await push(base, 3) });
      expect(await fails(manifest.swap({ store, lock, base, next: mine }))).toEqual(jasmine.any(StaleManifestError));
    });

    it("rethrows the error when the outcome was unknown and the manifest is not there", async function () {
      const next = await push(base, 2);
      const error = dropped();
      store.inject("putIfAbsent", { key: manifestKey(2), before: error });

      expect(await fails(manifest.swap({ store, lock, base, next }))).toBe(error);
      expect(await store.head(manifestKey(2))).toBeNull();
      expect((await manifest.read(store)).seq).toBe(1);
    });

    it("rethrows a definite rejection without reading the manifest back", async function () {
      const next = await push(base, 2);
      const error = refused(403);
      store.inject("putIfAbsent", { key: manifestKey(2), before: error });

      expect(await fails(manifest.swap({ store, lock, base, next }))).toBe(error);
      expect(manifestGets().length).toBe(0);
    });

    it("says the outcome is unknown when the confirming read fails", async function () {
      const next = await push(base, 2);
      const cause = dropped();
      store.inject("putIfAbsent", { key: manifestKey(2), after: cause });
      store.inject("get", { key: manifestKey(2), before: dropped() });

      const error = await fails(manifest.swap({ store, lock, base, next }));
      expect(error).toEqual(jasmine.any(OutcomeUnknownError));
      expect(error.code).toBe("OUTCOME_UNKNOWN");
      expect(error.cause).toBe(cause);
    });

    it("says the outcome is unknown when the create answered false and the read fails", async function () {
      const next = await push(base, 2);
      store.inject("putIfAbsent", { key: manifestKey(2), result: false });
      store.inject("get", { key: manifestKey(2), before: dropped() });
      expect(await fails(manifest.swap({ store, lock, base, next }))).toEqual(jasmine.any(OutcomeUnknownError));
    });

    it("says the outcome is unknown when the read comes back cut short", async function () {
      const next = await push(base, 2);
      store.inject("putIfAbsent", { key: manifestKey(2), after: dropped() });
      store.inject("get", { key: manifestKey(2), truncate: 20 });
      expect(await fails(manifest.swap({ store, lock, base, next }))).toEqual(jasmine.any(OutcomeUnknownError));
    });

    it("lets the same swap be tried again after an unknown outcome, and finds it landed", async function () {
      const next = await push(base, 2);
      store.inject("putIfAbsent", { key: manifestKey(2), after: dropped() });
      store.inject("get", { key: manifestKey(2), before: dropped() });
      expect(await fails(manifest.swap({ store, lock, base, next }))).toEqual(jasmine.any(OutcomeUnknownError));

      expect(await manifest.swap({ store, lock, base, next })).toEqual(next);
      expect(await manifest.read(store)).toEqual(next);
    });

    it("does not take another writer's manifest at that seq for its own on a retry", async function () {
      const mine = await push(base, 2);
      await manifest.swap({ store, lock, base, next: await push(base, 3) });
      expect(await fails(manifest.swap({ store, lock, base, next: mine }))).toEqual(jasmine.any(StaleManifestError));
    });
  });

  describe("finding the manifest with a stale hint", function () {
    it("reads the newest manifest when the hint names an older one", async function () {
      const store = faults(createMemoryStore());
      let current = manifest.empty();
      for (const n of [1, 2, 3]) {
        const entry = packEntry(n);
        await uploaded(store, entry);
        const next = manifest.advance(current, { refs: { "refs/heads/master": oid(n) }, packs: [entry] });
        await manifest.swap({ store, lock, base: current, next });
        current = next;
      }

      store.inject("get", { key: LATEST_KEY, answer: Buffer.from('{"seq":1}\n') });
      const fresh = faults(store);
      expect(await manifest.read(fresh)).toEqual(current);
    });

    it("reads the newest manifest when the hint is ahead of what exists", async function () {
      const store = faults(createMemoryStore());
      const entry = packEntry(1);
      await uploaded(store, entry);
      const next = manifest.advance(manifest.empty(), { refs: { "refs/heads/master": oid(1) }, packs: [entry] });
      await manifest.swap({ store, lock, base: manifest.empty(), next });

      const fresh = faults(store);
      fresh.inject("get", { key: LATEST_KEY, answer: Buffer.from('{"seq":9}\n') });
      expect(await manifest.read(fresh)).toEqual(next);
    });
  });

  describe("reading a repository", function () {
    let workDir;
    let fixture;
    let oracle;
    let pack;

    beforeAll(function () {
      workDir = fx.tempDir();
      fixture = fx.buildFixture(workDir + "/repo", { commits: 6, large: false });
      fx.repackAll(fixture.dir);
      oracle = fx.catAll(fixture.dir);
      [pack] = fx.readPacks(fixture.dir);
    });

    afterAll(function () {
      fx.remove(workDir);
    });

    // `byRange` gives the reader a cache too small for it to read the index
    // whole (idx.js), so it reads it by range as a big index is
    let caches = 0;
    async function open({ cache = null, byRange = false } = {}) {
      const store = faults(createMemoryStore());
      const entry = await fx.upload(store, pack, oracle.size);
      if (byRange) cache = createCache({ dir: workDir + "/range-cache-" + ++caches, maxBytes: 8 * pack.idx.length });
      return { store, entry, reader: createReader({ store, cache, packs: [entry] }) };
    }

    // Reads every object; each is either exactly git's bytes or an error
    async function readAll(reader) {
      const errors = [];
      for (const [id, want] of oracle) {
        try {
          const got = await reader.read(id);
          if (!got || !got.data.equals(want.data)) fail("Object " + id + " read back as the wrong bytes");
        } catch (err) {
          errors.push(err);
        }
      }
      return errors;
    }

    for (const [what, key, op, byRange] of [
      ["ranged reads of the pack", /\.pack$/, "read", false],
      ["ranged reads of the index", /\.idx$/, "read", true],
      ["the GET of the whole index", /\.idx$/, "get", false],
    ]) {
      for (const [how, truncate] of [
        ["to nothing", 0],
        ["by half", (body) => body.length >> 1],
        ["by a byte", (body) => Math.max(body.length - 1, 0)],
      ]) {
        it("never gives wrong bytes when " + what + " are cut short " + how, async function () {
          const { store, reader } = await open({ byRange });
          store.inject(op, { key, times: Infinity, truncate });

          const errors = await readAll(reader);
          for (const err of errors) expect(err).toEqual(jasmine.any(CorruptError));
          if (truncate === 0) expect(errors.length).toBe(oracle.size);
        });
      }
    }

    it("gives CorruptError when a streamed read of a pack entry is cut short", async function () {
      const { store, reader } = await open();
      store.inject("read", { key: /\.pack$/, times: Infinity, truncate: 0 });
      const [id] = [...oracle.keys()];
      const error = await fails(reader.stream(id).then((out) => collect(out.data)));
      expect(error).toEqual(jasmine.any(CorruptError));
    });

    it("does not keep a cut-short ranged index read in the cache", async function () {
      const { store, reader } = await open({ byRange: true });
      store.inject("read", { key: /\.idx$/, truncate: (body) => body.length >> 1 });

      const [id, want] = [...oracle.entries()][0];
      expect(await fails(reader.read(id))).toEqual(jasmine.any(CorruptError));

      const again = await reader.read(id);
      expect(again.data.equals(want.data)).toBe(true);
      expect((await readAll(reader)).length).toBe(0);
    });

    it("does not keep a cut-short or damaged whole index in the cache, nor in memory", async function () {
      const cache = createCache({ dir: workDir + "/cache", maxBytes: 50 * 1024 * 1024 });
      const { store, entry, reader } = await open({ cache });
      store.inject("get", { key: /\.idx$/, truncate: (body) => body.length >> 1 });

      const [id, want] = [...oracle.entries()][0];
      expect(await fails(reader.read(id))).toEqual(jasmine.any(CorruptError));

      // The right length, and a flipped bit: its own checksum catches it
      const damaged = Buffer.from(pack.idx);
      damaged[2000] ^= 0x10;
      store.inject("get", { key: /\.idx$/, result: damaged });
      expect(await fails(reader.read(id))).toEqual(jasmine.any(CorruptError));

      const again = await reader.read(id);
      expect(again.data.equals(want.data)).toBe(true);
      expect((await readAll(reader)).length).toBe(0);

      // A new reader takes the index from the cache, and it is the good one
      const before = store.calls.length;
      const next = createReader({ store, cache, packs: [entry] });
      expect((await readAll(next)).length).toBe(0);
      expect(store.calls.slice(before).filter((call) => call.endsWith(".idx"))).toEqual([]);
    });

    it("shares one fetch of an index between lookups which need it at the same time", async function () {
      const idxCalls = (store) => store.calls.filter((call) => call.endsWith(".idx")).length;
      const [id] = [...oracle.keys()];

      for (const byRange of [false, true]) {
        const alone = await open({ byRange });
        await alone.reader.read(id);
        const one = idxCalls(alone.store);

        const together = await open({ byRange });
        together.store.inject(byRange ? "read" : "get", { key: /\.idx$/, times: Infinity, delay: 20 });
        const results = await Promise.all(Array.from({ length: 10 }, () => together.reader.read(id)));

        expect(results.every((got) => got.data.equals(oracle.get(id).data))).toBe(true);
        expect(idxCalls(together.store)).toBe(one);
      }
    });

    it("refuses an index which is not the length the manifest says", async function () {
      const { store, entry } = await open();
      for (const idxSize of [entry.idxSize - 1, entry.idxSize + 1]) {
        const reader = createReader({ store, packs: [{ ...entry, idxSize }] });
        expect(await fails(reader.read(fixture.head))).toEqual(jasmine.any(CorruptError));
      }
    });

    it("refuses a pack which is not the length the manifest says", async function () {
      const { store, entry } = await open();
      await store.put("packs/" + entry.name + ".pack", Buffer.concat([pack.pack, Buffer.alloc(7)]));
      const reader = createReader({ store, packs: [entry] });
      expect(await fails(reader.read(fixture.head))).toEqual(jasmine.any(CorruptError));
    });

    it("leaves the current manifest readable when a push dies between its uploads", async function () {
      const store = faults(createMemoryStore());
      const entry = await fx.upload(store, pack, oracle.size);
      const first = manifest.advance(manifest.empty(), {
        refs: { "refs/heads/master": fixture.head },
        head: "refs/heads/master",
        packs: [entry],
      });
      await manifest.swap({ store, lock, base: manifest.empty(), next: first });

      // A second push: its pack goes up, then the process dies before the
      // index, then (on a retry) after both but before the manifest
      const second = fx.indexPack(fx.packRevs(fixture.dir, [fixture.commits[2]]));
      const orphan = { name: second.name, size: second.pack.length, idxSize: second.idx.length, objects: 1 };
      store.inject("put", { key: "packs/" + second.name + ".idx", before: dropped() });
      expect(await fails(fx.upload(store, second, 1))).not.toBeNull();
      expect(await store.head("packs/" + second.name + ".pack")).not.toBeNull();
      expect(await store.head("packs/" + second.name + ".idx")).toBeNull();

      const next = manifest.advance(first, { refs: { "refs/heads/master": fixture.commits[2] }, packs: [orphan] });
      const early = await fails(manifest.swap({ store, lock, base: first, next }));
      expect(early).toEqual(jasmine.any(StaleManifestError)); // the manifest will not name a half-uploaded pack

      await fx.upload(store, second, 1);
      store.inject("putIfAbsent", { key: manifestKey(2), before: dropped() });
      expect(await fails(manifest.swap({ store, lock, base: first, next }))).not.toBeNull();

      // Whatever happened, the repository is still the first manifest...
      const current = await manifest.read(store);
      expect(current).toEqual(first);

      // ...and reads exactly as git does, with the orphan pack ignored
      const reader = createReader({ store, packs: current.packs });
      expect(reader.packs).toEqual([entry.name]);
      expect((await readAll(reader)).length).toBe(0);
      expect((await store.head("packs/" + second.name + ".pack")).size).toBe(orphan.size);
    });
  });
});
