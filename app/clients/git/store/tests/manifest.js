const manifest = require("../manifest");
const createMemoryStore = require("../objectStore/memory");
const { CorruptError, StaleManifestError } = require("../errors");
const { MANIFEST_KEY } = require("../layout");

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
      const spy = spyOn(store, "put").and.callFake(async (...args) => {
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
      expect(await store.head(MANIFEST_KEY)).toBeNull();
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
      expect(await store.head(MANIFEST_KEY)).toBeNull();
    });

    it("reads a damaged manifest as an error, not an empty repository", async function () {
      await store.put(MANIFEST_KEY, Buffer.from("{"));
      expect(await fails(manifest.read(store))).toEqual(jasmine.any(CorruptError));
    });
  });
});
