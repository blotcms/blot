const manifest = require("../manifest");
const createMemoryStore = require("../objectStore/memory");
const { CorruptError, StaleManifestError, ManifestTooLargeError } = require("../errors");
const { LATEST_KEY, manifestKey, manifestSeq } = require("../layout");

const oid = (n) => String(n).repeat(40).slice(0, 40);
const packName = (n) => "pack-" + oid(n);

function packEntry(n, extra = {}) {
  return { name: packName(n), size: 1000 + n, idxSize: 500 + n, objects: 10 + n, ...extra };
}

// What the host's lock does: one swap at a time
function createLock() {
  let tail = Promise.resolve();
  function lock(fn) {
    lock.calls++;
    const run = tail.then(fn);
    tail = run.catch(() => {});
    return run;
  }
  lock.calls = 0;
  return lock;
}

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

describe("git store manifest", function () {
  describe("format", function () {
    function sample() {
      const first = manifest.advance(manifest.empty(), {
        refs: { "refs/heads/master": oid(1) },
        head: "refs/heads/master",
        packs: [packEntry(1)],
      });
      return manifest.advance(first, {
        refs: { "refs/heads/master": oid(2), "refs/tags/v1": oid(3) },
        packs: [packEntry(2)],
        history: { ...packEntry(9), through: 1 },
      });
    }

    it("starts empty", function () {
      const m = manifest.empty();
      expect(m.seq).toBe(0);
      expect(m.packs).toEqual([]);
      expect(() => manifest.validate(m)).not.toThrow();
    });

    it("advances by one, with a snapshot of the refs after each push", function () {
      const m = sample();
      expect(m.seq).toBe(2);
      expect(m.packs.map((p) => [p.name, p.seq])).toEqual([[packName(1), 1], [packName(2), 2]]);
      expect(m.snapshots).toEqual([
        { seq: 1, refs: { "refs/heads/master": oid(1) } },
        { seq: 2, refs: { "refs/heads/master": oid(2), "refs/tags/v1": oid(3) } },
      ]);
      expect(m.history.through).toBe(1);
    });

    it("keeps the head and history it already has unless told otherwise", function () {
      const next = manifest.advance(sample(), { refs: { "refs/heads/master": oid(4) } });
      expect(next.head).toBe("refs/heads/master");
      expect(next.history.name).toBe(packName(9));
    });

    it("round-trips through bytes", function () {
      const m = sample();
      expect(manifest.parse(manifest.serialize(m))).toEqual(m);
    });

    it("serialises the same manifest to the same bytes whatever order its refs are in", function () {
      const a = sample();
      const b = { ...a, refs: { "refs/tags/v1": oid(3), "refs/heads/master": oid(2) } };
      expect(manifest.serialize(a).equals(manifest.serialize(b))).toBe(true);
    });

    it("carries a version", function () {
      expect(JSON.parse(manifest.serialize(sample())).version).toBe(manifest.VERSION);
    });

    const invalid = {
      "a newer version": (m) => (m.version = 2),
      "no version": (m) => delete m.version,
      "a negative seq": (m) => (m.seq = -1),
      "a fractional seq": (m) => (m.seq = 1.5),
      "no writer": (m) => delete m.writer,
      "a writer which is not a string": (m) => (m.writer = 7),
      "an empty writer after seq 0": (m) => (m.writer = ""),
      "a writer with odd characters": (m) => (m.writer = "a b"),
      "a ref outside refs/": (m) => (m.refs["heads/master"] = oid(1)),
      "a ref name with a space": (m) => (m.refs["refs/heads/a b"] = oid(1)),
      "a ref name with ..": (m) => (m.refs["refs/heads/a..b"] = oid(1)),
      "a short object ID": (m) => (m.refs["refs/heads/master"] = "abc"),
      "an uppercase object ID": (m) => (m.refs["refs/heads/master"] = "A".repeat(40)),
      "a head which is not a ref": (m) => (m.head = "master"),
      "a pack with a bad name": (m) => (m.packs[0].name = "pack-xyz"),
      "a pack listed twice": (m) => m.packs.push({ ...m.packs[0] }),
      "a pack newer than the manifest": (m) => (m.packs[0].seq = 99),
      "a pack with no size": (m) => delete m.packs[0].size,
      "snapshots out of order": (m) => m.snapshots.reverse(),
      "a snapshot newer than the manifest": (m) => (m.snapshots[1].seq = 3),
      "a snapshot with a bad ref": (m) => (m.snapshots[0].refs["refs/heads/master"] = "nope"),
      "packs which are not a list": (m) => (m.packs = {}),
      "a history newer than the manifest": (m) => (m.history.through = 3),
    };

    for (const [name, damage] of Object.entries(invalid)) {
      it("rejects " + name, function () {
        const m = JSON.parse(JSON.stringify(sample()));
        damage(m);
        expect(() => manifest.validate(m)).toThrowError(CorruptError);
        expect(() => manifest.parse(Buffer.from(JSON.stringify(m)))).toThrowError(CorruptError);
      });
    }

    it("rejects bytes which are not JSON", function () {
      expect(() => manifest.parse(Buffer.from("{nope"))).toThrowError(CorruptError);
      expect(() => manifest.parse(Buffer.from("[]"))).toThrowError(CorruptError);
      expect(() => manifest.parse(Buffer.from("null"))).toThrowError(CorruptError);
    });

    it("refuses to serialise an invalid manifest", function () {
      expect(() => manifest.serialize({ ...sample(), seq: -3 })).toThrowError(CorruptError);
    });
  });

  describe("reading and swapping", function () {
    let store;
    let lock;

    beforeEach(function () {
      store = createMemoryStore();
      lock = createLock();
    });

    async function push(base, n) {
      const pack = packEntry(n);
      await uploaded(store, pack);
      return manifest.advance(base, { refs: { "refs/heads/master": oid(n) }, packs: [pack] });
    }

    it("reads a repository which has no manifest as an empty one", async function () {
      expect(await manifest.read(store)).toEqual(manifest.empty());
    });

    it("writes the first manifest and reads it back", async function () {
      const next = await push(await manifest.read(store), 1);
      await manifest.swap({ store, lock, base: manifest.empty(), next });
      expect(await manifest.read(store)).toEqual(next);
    });

    it("writes the next one", async function () {
      const first = await push(manifest.empty(), 1);
      await manifest.swap({ store, lock, base: manifest.empty(), next: first });
      const second = await push(first, 2);
      await manifest.swap({ store, lock, base: first, next: second });
      expect((await manifest.read(store)).seq).toBe(2);
    });

    it("writes each swap as a manifest of its own and never overwrites one", async function () {
      const first = await push(manifest.empty(), 1);
      await manifest.swap({ store, lock, base: manifest.empty(), next: first });
      const before = await store.get(manifestKey(1));
      const second = await push(first, 2);
      await manifest.swap({ store, lock, base: first, next: second });

      expect((await store.get(manifestKey(1))).equals(before)).toBe(true);
      expect(manifest.parse(await store.get(manifestKey(2)))).toEqual(second);
      expect(store.stats.puts).toBe(4 + 2); // 2 packs x 2 files uploaded by push(), and one hint per swap
      expect(store.stats.putIfAbsents).toBe(2);
    });

    it("takes the host's lock for the swap", async function () {
      let held = false;
      let during;
      const watching = async (fn) => {
        held = true;
        try {
          return await fn();
        } finally {
          held = false;
        }
      };
      const next = await push(manifest.empty(), 1);
      const spy = spyOn(store, "putIfAbsent").and.callFake(async (...args) => {
        during = held;
        return spy.and.callThrough()(...args);
      });
      await manifest.swap({ store, lock: watching, base: manifest.empty(), next });
      expect(during).toBe(true);
    });

    it("rejects a swap whose base has moved, and writes nothing", async function () {
      const first = await push(manifest.empty(), 1);
      await manifest.swap({ store, lock, base: manifest.empty(), next: first });

      // Someone else pushed from the same base first
      const mine = await push(first, 2);
      const theirs = await push(first, 3);
      await manifest.swap({ store, lock, base: first, next: theirs });

      const error = await fails(manifest.swap({ store, lock, base: first, next: mine }));
      expect(error).toEqual(jasmine.any(StaleManifestError));
      expect(await manifest.read(store)).toEqual(theirs);
    });

    it("lets only one of two concurrent swaps from the same base win", async function () {
      const base = await push(manifest.empty(), 1);
      await manifest.swap({ store, lock, base: manifest.empty(), next: base });
      const a = await push(base, 2);
      const b = await push(base, 3);

      const results = await Promise.all([
        fails(manifest.swap({ store, lock, base, next: a })),
        fails(manifest.swap({ store, lock, base, next: b })),
      ]);

      expect(results.filter(Boolean).length).toBe(1);
      expect(results.find(Boolean)).toEqual(jasmine.any(StaleManifestError));
      expect((await manifest.read(store)).seq).toBe(2);
    });

    it("rejects a manifest which does not follow its base", async function () {
      const first = await push(manifest.empty(), 1);
      const skipped = { ...(await push(first, 2)), seq: 5 };
      expect(await fails(manifest.swap({ store, lock, base: first, next: skipped }))).toEqual(jasmine.any(StaleManifestError));
      expect(await fails(manifest.swap({ store, lock, base: first, next: first }))).toEqual(jasmine.any(StaleManifestError));
    });

    it("rejects a manifest naming a pack which is not uploaded, and writes nothing", async function () {
      const next = manifest.advance(manifest.empty(), { refs: { "refs/heads/master": oid(1) }, packs: [packEntry(1)] });
      const error = await fails(manifest.swap({ store, lock, base: manifest.empty(), next }));
      expect(error).toEqual(jasmine.any(StaleManifestError));
      expect(error.message).toMatch(/not uploaded/);
      expect(await store.head(manifestKey(1))).toBeNull();
      expect(lock.calls).toBe(0);
    });

    it("rejects a pack which has only its index uploaded, or the wrong size", async function () {
      const pack = packEntry(1);
      await store.put("packs/" + pack.name + ".idx", Buffer.alloc(pack.idxSize));
      const next = manifest.advance(manifest.empty(), { refs: {}, packs: [pack] });
      expect(await fails(manifest.swap({ store, lock, base: manifest.empty(), next }))).toEqual(jasmine.any(StaleManifestError));

      await store.put("packs/" + pack.name + ".pack", Buffer.alloc(pack.size - 1));
      expect(await fails(manifest.swap({ store, lock, base: manifest.empty(), next }))).toEqual(jasmine.any(StaleManifestError));
    });

    it("checks a new history pack is uploaded too", async function () {
      const first = await push(manifest.empty(), 1);
      await manifest.swap({ store, lock, base: manifest.empty(), next: first });
      const next = manifest.advance(first, { refs: first.refs, history: { ...packEntry(8), through: 1 } });
      expect(await fails(manifest.swap({ store, lock, base: first, next }))).toEqual(jasmine.any(StaleManifestError));

      await uploaded(store, packEntry(8));
      await manifest.swap({ store, lock, base: first, next });
    });

    it("does not recheck packs the base already named", async function () {
      const first = await push(manifest.empty(), 1);
      await manifest.swap({ store, lock, base: manifest.empty(), next: first });
      await store.delete("packs/" + packName(1) + ".pack");

      const next = manifest.advance(first, { refs: { "refs/heads/master": oid(5) } });
      await manifest.swap({ store, lock, base: first, next });
    });

    it("needs a lock", async function () {
      const next = await push(manifest.empty(), 1);
      const error = await fails(manifest.swap({ store, base: manifest.empty(), next }));
      expect(error.message).toMatch(/lock/);
    });

    it("passes on a failure in the lock, and writes nothing", async function () {
      const next = await push(manifest.empty(), 1);
      const broken = async () => {
        throw new Error("could not get the lock");
      };
      const error = await fails(manifest.swap({ store, lock: broken, base: manifest.empty(), next }));
      expect(error.message).toBe("could not get the lock");
      expect(await store.head(manifestKey(1))).toBeNull();
    });

    it("reads a damaged manifest as an error, not an empty repository", async function () {
      await store.put(manifestKey(1), Buffer.from("{"));
      expect(await fails(manifest.read(store))).toEqual(jasmine.any(CorruptError));
    });

    it("reads a manifest which says it is some other seq as an error", async function () {
      const first = await push(manifest.empty(), 1);
      await store.put(manifestKey(2), manifest.serialize(first));
      await store.put(LATEST_KEY, Buffer.from('{"seq":2}'));
      expect(await fails(manifest.read(store))).toEqual(jasmine.any(CorruptError));
    });
  });

  describe("what makes a swap safe", function () {
    let store;
    let lock;

    beforeEach(function () {
      store = createMemoryStore();
      lock = createLock();
    });

    async function push(base, n) {
      const pack = packEntry(n);
      await uploaded(store, pack);
      return manifest.advance(base, { refs: { "refs/heads/master": oid(n) }, packs: [pack] });
    }

    it("stops a writer which stalled with its lock expired while another swap landed", async function () {
      const first = await push(manifest.empty(), 1);
      await manifest.swap({ store, lock, base: manifest.empty(), next: first });
      const stalled = await push(first, 2);
      const winner = await push(first, 3);

      // The stalled writer passes every check, then stops just before its
      // write; its lock runs out, so the other writer takes it and swaps
      const real = store.putIfAbsent;
      let stalledOnce = false;
      spyOn(store, "putIfAbsent").and.callFake(async (...args) => {
        if (!stalledOnce) {
          stalledOnce = true;
          await manifest.swap({ store, lock: (fn) => fn(), base: first, next: winner });
        }
        return real(...args);
      });

      const error = await fails(manifest.swap({ store, lock: (fn) => fn(), base: first, next: stalled }));
      expect(error).toEqual(jasmine.any(StaleManifestError));
      expect(await manifest.read(store)).toEqual(winner);
      expect(manifest.parse(await store.get(manifestKey(2)))).toEqual(winner);
    });

    it("lets only one of two swaps from the same base win with no lock at all", async function () {
      const base = await push(manifest.empty(), 1);
      await manifest.swap({ store, lock, base: manifest.empty(), next: base });
      const a = await push(base, 2);
      const b = await push(base, 3);
      const none = (fn) => fn();

      const results = await Promise.all([
        fails(manifest.swap({ store, lock: none, base, next: a })),
        fails(manifest.swap({ store, lock: none, base, next: b })),
      ]);

      expect(results.filter(Boolean).length).toBe(1);
      expect(results.find(Boolean)).toEqual(jasmine.any(StaleManifestError));
      expect([a, b]).toContain(await manifest.read(store));
    });

    it("refuses a manifest too big to be read back, and writes nothing", async function () {
      // One ref with a name of 64 MiB is the cheapest way to make one
      const huge = manifest.advance(manifest.empty(), { refs: { ["refs/heads/" + "a".repeat(64 * 1024 * 1024)]: oid(1) } });
      const error = await fails(manifest.swap({ store, lock, base: manifest.empty(), next: huge }));
      expect(error).toEqual(jasmine.any(ManifestTooLargeError));
      expect(error.code).toBe("MANIFEST_TOO_LARGE");
      expect(store.stats.putIfAbsents).toBe(0);
      expect(store.stats.puts).toBe(0);
      expect(lock.calls).toBe(0);
      expect(await manifest.read(store)).toEqual(manifest.empty());
    });

  });

  describe("finding the newest manifest", function () {
    let store;
    let lock;
    let chain;

    // The manifests for seq 1 to n, without any written
    async function build(n) {
      const out = [manifest.empty()];
      for (let i = 1; i <= n; i++) {
        const pack = packEntry(i);
        await uploaded(store, pack);
        out.push(manifest.advance(out[i - 1], { refs: { "refs/heads/master": oid(i) }, packs: [pack] }));
      }
      return out;
    }

    // Writes manifests 1 to n as another process would have: this one's cache doesn't know them
    async function writeAll(n) {
      chain = await build(n);
      for (let i = 1; i <= n; i++) await store.putIfAbsent(manifestKey(i), manifest.serialize(chain[i]));
    }

    const hint = (value) => store.put(LATEST_KEY, Buffer.from(typeof value === "string" ? value : JSON.stringify({ seq: value })));

    function reset() {
      for (const key of Object.keys(store.stats)) store.stats[key] = 0;
    }

    beforeEach(function () {
      store = createMemoryStore();
      lock = createLock();
    });

    it("names its keys so that they sort in order", function () {
      expect(manifestKey(2) < manifestKey(10)).toBe(true);
      expect(manifestSeq(manifestKey(42))).toBe(42);
      expect(manifestSeq(LATEST_KEY)).toBeNull();
      expect(() => manifestKey(0)).toThrow();
    });

    it("writes the hint after a swap, and overwrites it each time", async function () {
      const chain = await build(2);
      await manifest.swap({ store, lock, base: chain[0], next: chain[1] });
      expect(JSON.parse(await store.get(LATEST_KEY))).toEqual({ seq: 1 });
      await manifest.swap({ store, lock, base: chain[1], next: chain[2] });
      expect(JSON.parse(await store.get(LATEST_KEY))).toEqual({ seq: 2 });
    });

    it("reads with the hint, one look forward and one GET, and no LIST", async function () {
      await writeAll(3);
      await hint(3);
      reset();
      expect(await manifest.read(store)).toEqual(chain[3]);
      expect(store.stats.gets).toBe(2);
      expect(store.stats.heads).toBe(1);
      expect(store.stats.lists).toBe(0);
    });

    it("does not fetch a manifest again once it has it", async function () {
      await writeAll(3);
      await hint(3);
      await manifest.read(store);
      reset();
      expect(await manifest.read(store)).toEqual(chain[3]);
      expect(store.stats.gets).toBe(1); // just the hint
      expect(store.stats.heads).toBe(1);
    });

    it("reads the manifest it just swapped in without fetching it", async function () {
      const chain = await build(1);
      await manifest.swap({ store, lock, base: chain[0], next: chain[1] });
      reset();
      expect(await manifest.read(store)).toEqual(chain[1]);
      expect(store.stats.gets).toBe(1);
    });

    it("hands out a manifest which is its caller's to change", async function () {
      await writeAll(1);
      await hint(1);
      (await manifest.read(store)).refs["refs/heads/other"] = oid(9);
      expect((await manifest.read(store)).refs).toEqual({ "refs/heads/master": oid(1) });
    });

    it("looks forward from a stale hint", async function () {
      await writeAll(4);
      await hint(1);
      reset();
      expect(await manifest.read(store)).toEqual(chain[4]);
      expect(store.stats.lists).toBe(0);
      expect(store.stats.heads).toBe(4);
    });

    it("lists instead when the hint is a long way behind", async function () {
      await writeAll(10);
      await hint(1);
      reset();
      expect(await manifest.read(store)).toEqual(chain[10]);
      expect(store.stats.lists).toBe(1);
    });

    it("lists when there is no hint", async function () {
      await writeAll(3);
      reset();
      expect(await manifest.read(store)).toEqual(chain[3]);
      expect(store.stats.lists).toBe(1);
    });

    for (const [name, bytes] of [
      ["not JSON", "{"],
      ["null", "null"],
      ["a seq which is not a number", '{"seq":"3"}'],
      ["a seq of zero", '{"seq":0}'],
      ["a negative seq", '{"seq":-2}'],
      ["a fractional seq", '{"seq":1.5}'],
      ["no seq", "{}"],
    ]) {
      it("lists when the hint is " + name, async function () {
        await writeAll(3);
        await hint(bytes);
        reset();
        expect(await manifest.read(store)).toEqual(chain[3]);
        expect(store.stats.lists).toBe(1);
      });
    }

    it("lists, rather than reading as empty, when the hint is ahead of what exists", async function () {
      await writeAll(3);
      await hint(9);
      expect(await manifest.read(store)).toEqual(chain[3]);
    });

    it("reads as empty when the hint is ahead and nothing exists", async function () {
      await hint(5);
      expect(await manifest.read(store)).toEqual(manifest.empty());
    });

    it("finds the newest by listing when the hint is missing and manifests are many", async function () {
      await writeAll(10); // keys 1 to 10 sort as numbers, not as strings
      expect((await manifest.read(store)).seq).toBe(10);
    });

    it("swaps successfully when the hint can't be written, and still reads the new manifest", async function () {
      const chain = await build(2);
      await manifest.swap({ store, lock, base: chain[0], next: chain[1] });

      const real = store.put;
      spyOn(store, "put").and.callFake(async (key, body) => {
        if (key === LATEST_KEY) throw new Error("the hint could not be written");
        return real(key, body);
      });
      await manifest.swap({ store, lock, base: chain[1], next: chain[2] });

      expect(JSON.parse(await store.get(LATEST_KEY))).toEqual({ seq: 1 });
      expect(await manifest.read(store)).toEqual(chain[2]);
    });

    it("does not read the hint as a manifest when it is the only thing there", async function () {
      await hint(1);
      expect(await manifest.read(store)).toEqual(manifest.empty());
    });
  });
});
