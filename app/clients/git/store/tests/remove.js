// Removing a repository (remove.js), and why it leaves a tombstone: processes
// keep the manifest they last read, and a removal followed by an import must
// never let one of them build on, or read, the old history as if it were the
// new one. "Processes" here are copies of one memory store object, since the
// manifest module keeps what it read per store object. The last spec imports
// a real repository with git after a removal.
const fs = require("fs");
const path = require("path");
const fx = require("./helpers/fixture");
const timeout = require("./helpers/timeout");
const manifest = require("../manifest");
const removeRepo = require("../remove");
const sweep = require("../sweep");
const importRepo = require("../import");
const { verifyImport } = importRepo;
const createCache = require("../cache");
const createMemoryStore = require("../objectStore/memory");
const { LATEST_KEY, SWEEP_KEY, manifestKey, manifestSeq, packKey, idxKey, revKey } = require("../layout");

const MASTER = "refs/heads/master";
const lock = (fn) => fn();
const oid = (n) => String(n % 10).repeat(40);

async function fails(promise) {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  return null;
}

describe("git store removal", function () {
  timeout(30 * 1000);

  let inner;
  let made;

  beforeEach(function () {
    inner = createMemoryStore();
    made = 0;
  });

  // Another process: its own memory of manifests, the same objects
  const processOf = () => ({ ...inner });

  // A pack of made-up bytes; the same `n` makes the same pack, as an import of
  // the same refs does (packs are named by their content)
  async function upload(store, n = ++made) {
    const name = "pack-" + String(n).padStart(40, "0");
    const entry = { name, size: 100 + n, idxSize: 1100 + n, objects: 1 };
    await store.put(packKey(name), Buffer.alloc(entry.size, n));
    await store.put(idxKey(name), Buffer.alloc(entry.idxSize, n));
    await store.put(revKey(name), Buffer.alloc(30, n));
    return entry;
  }

  // A push of master to oid(n) with a pack of its own, by `store`
  async function pushOf(store, n) {
    const pack = await upload(store);
    const base = await manifest.read(store);
    const next = manifest.advance(base, { refs: { [MASTER]: oid(n) }, head: MASTER, packs: [pack] });
    await manifest.swap({ store, lock, base, next });
    return next;
  }

  // An import as importRepo makes it, onto whatever empty manifest is there
  async function importOf(store, n, packN) {
    const pack = await upload(store, packN);
    const base = await manifest.read(store);
    expect(manifest.isEmpty(base)).toBe(true);
    const next = manifest.advance(base, { refs: { [MASTER]: oid(n) }, head: MASTER, packs: [pack] });
    await manifest.swap({ store, lock, base, next });
    return next;
  }

  const keys = () => [...inner.objects.keys()].sort();

  // Every pack the newest manifest names has its .pack and .idx in the store
  async function namedAreThere() {
    const newest = await manifest.read(processOf());
    return manifest.packsNamed(newest).every((name) => inner.objects.has(packKey(name)) && inner.objects.has(idxKey(name)));
  }

  describe("the bug it fixes", function () {
    it("deleting everything and importing again let a process holding the old newest manifest land on the new history", async function () {
      const a = processOf();
      await pushOf(a, 1);
      await pushOf(a, 2);
      const stale = await manifest.read(a);
      expect(stale.seq).toBe(2);

      // The old removal: every key deleted, then a fresh import and a push
      for (const key of keys()) await inner.delete(key);
      const b = processOf();
      await importOf(b, 7);
      await pushOf(b, 8);
      expect((await manifest.read(processOf())).seq).toBe(2);

      // A builds on the old seq 2: seq 3 is free, so it lands, on the new
      // history, with the old history's refs
      await manifest.swap({ store: a, lock, base: stale, next: manifest.advance(stale, { refs: { [MASTER]: oid(3) } }) });
      const newest = await manifest.read(processOf());
      expect(newest.seq).toBe(3);
      expect(newest.refs[MASTER]).toBe(oid(3));
    });
  });

  describe("removeRepo", function () {
    it("swaps in a tombstone, deletes every pack and the sweep's record, and keeps the manifests and the hint", async function () {
      await pushOf(inner, 1);
      const before = await pushOf(inner, 2);
      await inner.put(SWEEP_KEY, Buffer.from("{}"));

      const result = await removeRepo({ store: processOf() });
      expect(result).toEqual({ outcome: "removed", seq: before.seq + 1, deleted: 3 * 2 + 1 });

      expect(keys()).toEqual([manifestKey(1), manifestKey(2), manifestKey(3), LATEST_KEY]);
      const tombstone = await manifest.read(processOf());
      expect(tombstone.seq).toBe(3);
      expect(manifest.isEmpty(tombstone)).toBe(true);
      expect(manifest.epochOf(tombstone)).not.toBe(manifest.epochOf(before));
      expect(tombstone.refs).toEqual({});
      expect(tombstone.packs).toEqual([]);
    });

    it("writes no second tombstone when run again with nothing to delete", async function () {
      await pushOf(inner, 1);
      await removeRepo({ store: processOf() });

      expect(await removeRepo({ store: processOf() })).toEqual({ outcome: "removed", seq: 2, deleted: 0 });
      expect(keys().map(manifestSeq).filter((seq) => seq !== null)).toEqual([1, 2]);
    });

    it("deletes what was uploaded since and puts a new tombstone on top, so the uploader cannot swap it in", async function () {
      await pushOf(inner, 1);
      await removeRepo({ store: processOf() });

      // An import reads the tombstone and uploads its pack, then stalls
      const importer = processOf();
      const tombstone = await manifest.read(importer);
      const late = await upload(importer);

      const again = await removeRepo({ store: processOf() });
      expect(again).toEqual({ outcome: "removed", seq: 3, deleted: 3 });
      expect(inner.objects.has(packKey(late.name))).toBe(false);

      const next = manifest.advance(tombstone, { refs: { [MASTER]: oid(7) }, head: MASTER, packs: [late] });
      const error = await fails(manifest.swap({ store: importer, lock, base: tombstone, next, uploaded: [late.name] }));
      expect(error && error.name).toBe("StaleManifestError");
      expect(await namedAreThere()).toBe(true);
    });

    it("writes nothing to an empty repository, and a tombstone after deleting the uploads of one with no manifest yet", async function () {
      expect(await removeRepo({ store: processOf() })).toEqual({ outcome: "removed", seq: 0, deleted: 0 });
      expect(keys()).toEqual([]);

      // An import's uploads, its swap still to come
      await upload(inner);
      expect(await removeRepo({ store: processOf() })).toEqual({ outcome: "removed", seq: 1, deleted: 3 });
      expect(keys()).toEqual([manifestKey(1), LATEST_KEY]);
      expect(manifest.isEmpty(await manifest.read(processOf()))).toBe(true);
      expect(await removeRepo({ store: processOf() })).toEqual({ outcome: "removed", seq: 1, deleted: 0 });
    });

    it("starts again from a manifest swapped in while it deleted, and deletes that one's packs too", async function () {
      await pushOf(inner, 1);
      const racing = processOf();
      let raced = false;
      const store = {
        ...inner,
        putIfAbsent: async (key, bytes) => {
          if (!raced) {
            raced = true;
            await pushOf(racing, 2);
          }
          return inner.putIfAbsent(key, bytes);
        },
      };

      const result = await removeRepo({ store });
      expect(result.seq).toBe(3);
      expect(manifest.isEmpty(await manifest.read(processOf()))).toBe(true);
      expect(keys().filter((key) => manifestSeq(key) === null && key !== LATEST_KEY)).toEqual([]);
    });

    it("throws when its tombstone keeps losing, and running it again finishes", async function () {
      await pushOf(inner, 1);
      const racing = processOf();
      let n = 1;
      const store = {
        ...inner,
        putIfAbsent: async (key, bytes) => {
          await pushOf(racing, ++n);
          return inner.putIfAbsent(key, bytes);
        },
      };

      const error = await fails(removeRepo({ store }));
      expect(error && error.code).toBe("EMOVED");
      expect(manifest.isEmpty(await manifest.read(processOf()))).toBe(false);

      const result = await removeRepo({ store: processOf() });
      expect(result.seq).toBe(n + 1);
      expect(manifest.isEmpty(await manifest.read(processOf()))).toBe(true);
      expect(keys().filter((key) => manifestSeq(key) === null && key !== LATEST_KEY)).toEqual([]);
    });

    describe("racing an import of the same refs, whose pack has the same name as one it deletes", function () {
      let old;

      beforeEach(async function () {
        old = await pushOf(inner, 1);
      });

      // The importer tries whenever the removal deletes a key: it only builds
      // on an empty manifest, and re-uploads the old pack (same name)
      function racingImport() {
        const importer = processOf();
        const state = { imported: null, tries: 0 };
        const store = {
          ...inner,
          delete: async (key) => {
            await inner.delete(key);
            if (state.imported) return;
            state.tries++;
            const base = await manifest.read(importer);
            if (manifest.isEmpty(base)) state.imported = await importOf(importer, 7, 1);
          },
        };
        return { store, state, importer };
      }

      it("never lets the import publish before the deletes are done, so the import's packs survive", async function () {
        const { store, state, importer } = racingImport();

        await removeRepo({ store });
        expect(state.tries).toBeGreaterThan(0);
        expect(state.imported).toBe(null);

        // The import after the removal: the same pack name, uploaded again
        const imported = await importOf(importer, 7, 1);
        expect(imported.packs[0].name).toBe(old.packs[0].name);
        expect(await namedAreThere()).toBe(true);
      });

      it("puts a second removal's tombstone over an import that landed on the first while it deleted", async function () {
        await removeRepo({ store: processOf() });

        // The import uploads the old pack's name again, then the second
        // removal (disconnect's second pass) lists it, and the import swaps
        // in while the removal deletes it
        const importer = processOf();
        const tombstone = await manifest.read(importer);
        const pack = await upload(importer, 1);
        let swapped = null;
        const store = {
          ...inner,
          delete: async (key) => {
            if (!swapped) {
              swapped = manifest.advance(tombstone, { refs: { [MASTER]: oid(7) }, head: MASTER, packs: [pack] });
              await manifest.swap({ store: importer, lock, base: tombstone, next: swapped, uploaded: [pack.name] });
            }
            await inner.delete(key);
          },
        };

        const result = await removeRepo({ store });
        expect(swapped.seq).toBe(3);
        expect(result.seq).toBe(4);
        expect(manifest.isEmpty(await manifest.read(processOf()))).toBe(true);
        expect(await namedAreThere()).toBe(true);
      });
    });

    describe("with a damaged newest manifest", function () {
      for (const [what, bytes] of [
        ["not JSON", Buffer.from("{ not json")],
        ["not a valid manifest", Buffer.from(JSON.stringify({ version: 99, seq: 2 }))],
      ]) {
        it("puts its tombstone after the largest number listed when the newest is " + what, async function () {
          await pushOf(inner, 1);
          await inner.put(manifestKey(2), bytes);
          await inner.put(LATEST_KEY, Buffer.from(JSON.stringify({ seq: 2 })));
          expect(await fails(manifest.read(processOf()))).not.toBe(null);

          const result = await removeRepo({ store: processOf() });
          expect(result).toEqual({ outcome: "removed", seq: 3, deleted: 3 });

          const tombstone = await manifest.read(processOf());
          expect(tombstone.seq).toBe(3);
          expect(manifest.isEmpty(tombstone)).toBe(true);
          expect(manifest.epochOf(tombstone)).not.toBe("");

          // An import goes above it
          expect((await importOf(processOf(), 7)).seq).toBe(4);
        });
      }

      it("leaves the sweep able to read past the damaged manifest it kept, and to delete it once it is old", async function () {
        const DAY = 24 * 60 * 60 * 1000;
        await pushOf(inner, 1);
        await inner.put(manifestKey(2), Buffer.from("{ not json"));
        await removeRepo({ store: processOf() });
        await importOf(processOf(), 7);
        await upload(inner); // an orphan, so the sweep reads the older manifests

        await sweep({ store: processOf() });
        expect(inner.objects.has(manifestKey(2))).toBe(true);

        for (let i = 0; i < 20; i++) await pushOf(processOf(), 8 + i);
        const stats = await sweep({ store: processOf(), now: Date.now() + 9 * DAY });
        expect(stats.manifestsDeleted).toBe(4);
        expect(inner.objects.has(manifestKey(2))).toBe(false);
        expect((await manifest.read(processOf())).seq).toBe(24);
      });

      it("leaves the sweep stopping on a damaged manifest no tombstone follows", async function () {
        await pushOf(inner, 1);
        await inner.put(manifestKey(2), Buffer.from("{ not json"));
        const m = manifest.advance(manifest.empty(), { refs: { [MASTER]: oid(3) }, head: MASTER });
        await inner.put(manifestKey(3), manifest.serialize({ ...m, seq: 3, snapshots: [{ seq: 3, refs: m.refs }] }));
        await upload(inner);

        const error = await fails(sweep({ store: processOf() }));
        expect(error && error.name).toBe("CorruptError");
      });

      it("starts again when another writer takes the number after the damaged one first", async function () {
        await pushOf(inner, 1);
        await inner.put(manifestKey(2), Buffer.from("{ not json"));
        let raced = false;
        const store = {
          ...inner,
          putIfAbsent: async (key, bytes) => {
            if (!raced) {
              raced = true;
              await inner.putIfAbsent(manifestKey(3), Buffer.from("{ also damaged"));
            }
            return inner.putIfAbsent(key, bytes);
          },
        };

        const result = await removeRepo({ store });
        expect(result.seq).toBe(4);
        expect(manifest.isEmpty(await manifest.read(processOf()))).toBe(true);
      });
    });
  });

  describe("after a removal and an import", function () {
    let a;
    let stale;
    let older;

    beforeEach(async function () {
      // Process A pushes twice and keeps both manifests it read
      a = processOf();
      await pushOf(a, 1);
      older = await manifest.read(a);
      await pushOf(a, 2);
      stale = await manifest.read(a);
      expect(stale.seq).toBe(2);

      // Another process removes the repository, and imports it again
      await removeRepo({ store: processOf() });
      await importOf(processOf(), 7);
    });

    it("numbers the import after the tombstone, never 1", async function () {
      const newest = await manifest.read(processOf());
      expect(newest.seq).toBe(4);
      expect(newest.refs[MASTER]).toBe(oid(7));
      expect(newest.packs.map((pack) => pack.seq)).toEqual([4]);
      expect(newest.snapshots.map((snapshot) => snapshot.seq)).toEqual([4]);
    });

    it("refuses a write built on the old newest manifest, which then reads the new one", async function () {
      const error = await fails(manifest.swap({ store: a, lock, base: stale, next: manifest.advance(stale, { refs: { [MASTER]: oid(3) } }) }));
      expect(error && error.name).toBe("StaleManifestError");

      const newest = await manifest.read(a);
      expect(newest.seq).toBe(4);
      expect(newest.refs[MASTER]).toBe(oid(7));
    });

    it("refuses a write built on an older manifest, which stalled across the removal", async function () {
      const error = await fails(manifest.swap({ store: a, lock, base: older, next: manifest.advance(older, { refs: { [MASTER]: oid(3) } }) }));
      expect(error && error.name).toBe("StaleManifestError");
      expect((await manifest.read(processOf())).refs[MASTER]).toBe(oid(7));
    });

    it("never serves the old manifest a process kept in memory, with the hint lagging behind it", async function () {
      await inner.put(LATEST_KEY, Buffer.from(JSON.stringify({ seq: 1 })));
      const newest = await manifest.read(a);
      expect(newest.seq).toBe(4);
      expect(newest.refs[MASTER]).toBe(oid(7));
    });

    it("gives the new history the tombstone's epoch, so nothing cached by object for the old one is used", async function () {
      const newest = await manifest.read(processOf());
      expect(manifest.epochOf(newest)).not.toBe(manifest.epochOf(stale));
      expect(manifest.epochOf(newest)).not.toBe("");
    });
  });

  describe("with a real import", function () {
    let root;

    beforeEach(function () {
      root = fx.tempDir();
    });

    afterEach(function () {
      fx.remove(root);
    });

    function makeRepo() {
      const work = path.join(root, "work");
      fs.mkdirSync(work);
      fx.git(work, ["init", "-q", "-b", "master"]);
      fs.writeFileSync(path.join(work, "post.md"), "# Post\n");
      fx.git(work, ["add", "-A"]);
      fx.git(work, ["commit", "-q", "-m", "Post"]);
      return path.join(work, ".git");
    }

    it("refuses an import which outlasted its base while a removal deleted its uploads", async function () {
      const gitDir = makeRepo();
      let now = Date.now();
      let removed = null;
      const late = async (fn) => {
        if (!removed) {
          now += manifest.MAX_BASE_AGE + 1;
          removed = await removeRepo({ store: processOf() });
        }
        return lock(fn);
      };

      const error = await fails(importRepo({ store: processOf(), cache: createCache({ dir: path.join(root, "cache"), maxBytes: 64 * 1024 * 1024 }), lock: late, gitDir, clock: () => now }));
      expect(removed).toEqual({ outcome: "removed", seq: 1, deleted: 5 });
      expect(error && error.code).toBe("EMOVED");

      const newest = await manifest.read(processOf());
      expect(newest.seq).toBe(1);
      expect(manifest.isEmpty(newest)).toBe(true);
    });

    it("imports into a removed repository above the tombstone, with its history through that seq, and verifies", async function () {
      const work = path.join(root, "work");
      fs.mkdirSync(work);
      fx.git(work, ["init", "-q", "-b", "master"]);
      for (let i = 1; i <= 3; i++) {
        fs.writeFileSync(path.join(work, "post-" + i + ".md"), "# Post " + i + "\n");
        fx.git(work, ["add", "-A"]);
        fx.git(work, ["commit", "-q", "-m", "Post " + i]);
      }
      const gitDir = path.join(work, ".git");
      const cache = () => createCache({ dir: path.join(root, "cache-" + ++made), maxBytes: 64 * 1024 * 1024 });

      const first = await importRepo({ store: processOf(), cache: cache(), lock, gitDir });
      expect(first.seq).toBe(1);

      const again = await fails(importRepo({ store: processOf(), cache: cache(), lock, gitDir }));
      expect(again && again.code).toBe("ENOTEMPTY");

      await removeRepo({ store: processOf() });
      const second = await importRepo({ store: processOf(), cache: cache(), lock, gitDir });
      expect(second.outcome).toBe("imported");
      expect(second.seq).toBe(3);

      const newest = await manifest.read(processOf());
      expect(newest.history.through).toBe(3);
      await verifyImport({ store: processOf(), cache: cache(), gitDir });
    });
  });
});
