// The sweep: old manifests deleted, and packs no kept manifest names marked on
// one run and deleted on a later one. Time is the memory store's clock and the
// sweep's `now`, moved on by hand, so nothing waits. The first part uses packs
// of made-up bytes, the second real repositories pushed with a real `git push`,
// compacted, swept, and then cloned and read back against `git cat-file`.
const fs = require("fs");
const path = require("path");
const fx = require("./helpers/fixture");
const faults = require("./helpers/faults");
const timeout = require("./helpers/timeout");
const { createReceiveServer, push } = require("./helpers/receiveServer");
const { startServer, runGit } = require("./helpers/upload-server");
const manifest = require("../manifest");
const compact = require("../compact");
const commit = require("../commit");
const sweep = require("../sweep");
const createCache = require("../cache");
const createMemoryStore = require("../objectStore/memory");
const createReader = require("../reader");
const {
  LATEST_KEY,
  SWEEP_KEY,
  manifestKey,
  manifestSeq,
  packKey,
  idxKey,
  revKey,
} = require("../layout");

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 0, 1);
const MASTER = "refs/heads/master";

const oid = (n) => String(n % 10).repeat(40);
const lock = (fn) => fn();
const dropped = () =>
  Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });

async function fails(promise) {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  return null;
}

describe("git store sweep", function () {
  timeout(30 * 1000);

  let clock;
  let inner;
  let store;
  let made;

  beforeEach(function () {
    clock = T0;
    made = 0;
    inner = createMemoryStore({ now: () => clock });
    store = faults(inner);
  });

  const at = (ms) => (clock = T0 + ms);
  const run = (options = {}) => sweep({ store, now: clock, ...options });

  // A pack of made-up bytes, its .idx and (unless it is a history piece) .rev
  async function upload({ rev = true } = {}) {
    const n = ++made;
    const name = "pack-" + String(n).padStart(40, "0");
    const entry = { name, size: 100 + n, idxSize: 1100 + n, objects: 1 };
    await store.put(packKey(name), Buffer.alloc(entry.size, n));
    await store.put(idxKey(name), Buffer.alloc(entry.idxSize, n));
    if (rev) await store.put(revKey(name), Buffer.alloc(30, n));
    return entry;
  }

  // Uploads the same bytes again, as a push of the same pack would
  async function reupload(entry) {
    await store.put(
      packKey(entry.name),
      Buffer.alloc(entry.size, Number(entry.name.slice(5)))
    );
    await store.put(
      idxKey(entry.name),
      Buffer.alloc(entry.idxSize, Number(entry.name.slice(5)))
    );
  }

  // A push naming `packs`, or of refs alone
  async function pushOf(packs = [], historyPieces = []) {
    const base = await manifest.read(store, { clock: () => clock });
    const next = manifest.advance(base, {
      refs: { [MASTER]: oid(base.seq + 1) },
      head: MASTER,
      packs,
      historyPieces,
    });
    await manifest.swap({ store, lock, base, next, clock: () => clock });
    return next;
  }

  // A compaction of `remove` into `add`
  async function compaction(remove, add, { history, removePieces } = {}) {
    const base = await manifest.read(store, { clock: () => clock });
    const next = manifest.compacted(base, {
      remove: remove.map((p) => p.name),
      add,
      history,
      removePieces,
    });
    await manifest.swap({ store, lock, base, next, clock: () => clock });
    return next;
  }

  const exists = (entry) =>
    inner.objects.has(packKey(entry.name)) ||
    inner.objects.has(idxKey(entry.name)) ||
    inner.objects.has(revKey(entry.name));
  const whole = (entry) =>
    inner.objects.has(packKey(entry.name)) &&
    inner.objects.has(idxKey(entry.name));
  const manifestSeqs = () =>
    [...inner.objects.keys()].map(manifestSeq).filter((seq) => seq !== null);
  const record = async () =>
    inner.objects.has(SWEEP_KEY)
      ? JSON.parse(await inner.get(SWEEP_KEY))
      : null;

  describe("packs", function () {
    let named;
    let orphan;

    beforeEach(async function () {
      named = await upload();
      await pushOf([named]);
      orphan = await upload();
    });

    it("marks an orphan once it is a grace old, and deletes it a grace after that", async function () {
      at(HOUR);
      expect((await run()).packsMarked).toBe(0);

      at(25 * HOUR);
      const marking = await run();
      expect(marking.packsMarked).toBe(1);
      expect(marking.packsDeleted).toBe(0);
      expect(marking.pending).toBe(1);
      expect(Object.keys((await record()).marked)).toEqual([orphan.name]);
      expect(exists(orphan)).toBe(true);

      // Not yet a grace since the mark
      at(48 * HOUR);
      const waiting = await run();
      expect(waiting.packsDeleted).toBe(0);
      expect(waiting.pending).toBe(1);
      expect(exists(orphan)).toBe(true);

      at(49 * HOUR);
      const deleting = await run();
      expect(deleting.packsDeleted).toBe(1);
      expect(deleting.bytesFreed).toBe(orphan.size + orphan.idxSize + 30);
      expect(deleting.pending).toBe(0);
      expect(exists(orphan)).toBe(false);
      expect(await record()).toBe(null);

      expect(whole(named)).toBe(true);
      expect((await manifest.read(store)).packs.map((p) => p.name)).toEqual([
        named.name,
      ]);
    });

    it("never deletes a pack a push has uploaded and not yet swapped in, within the grace", async function () {
      at(25 * HOUR);
      const inFlight = await upload();
      for (const hours of [26, 40, 48]) {
        at(hours * HOUR);
        await run();
        expect(whole(inFlight)).toBe(true);
      }
      expect(Object.keys((await record()).marked)).not.toContain(inFlight.name);

      // Its push swaps at last, and it is never touched
      await pushOf([inFlight]);
      at(100 * HOUR);
      await run();
      expect(whole(inFlight)).toBe(true);
      expect(exists(orphan)).toBe(false);
    });

    it("spares a marked pack uploaded again before it is deleted, and deletes it once it is an orphan for long enough", async function () {
      at(25 * HOUR);
      expect((await run()).packsMarked).toBe(1);

      // A push of the same pack has uploaded it, and has not swapped yet
      at(30 * HOUR);
      await reupload(orphan);

      at(50 * HOUR);
      const result = await run();
      expect(result.packsSpared).toBe(1);
      expect(result.packsDeleted).toBe(0);
      expect(result.pending).toBe(0);
      expect(whole(orphan)).toBe(true);

      // The push never swapped: it is an orphan again, marked once old, and
      // deleted a grace after that
      at(56 * HOUR);
      expect((await run()).packsMarked).toBe(1);
      at(81 * HOUR);
      expect((await run()).packsDeleted).toBe(1);
      expect(exists(orphan)).toBe(false);
    });

    it("spares a marked pack uploaded again and swapped in before it is deleted", async function () {
      at(25 * HOUR);
      await run();
      at(30 * HOUR);
      await reupload(orphan);
      await pushOf([orphan]);

      at(60 * HOUR);
      const result = await run();
      expect(result.packsSpared).toBe(1);
      expect(result.packsDeleted).toBe(0);
      expect(whole(orphan)).toBe(true);
      expect(await record()).toBe(null);
    });

    it("spares a marked pack a manifest swapped in during the sweep names", async function () {
      at(25 * HOUR);
      await run();

      // Named (without an upload, which is the HEAD's job to catch) between
      // the sweep's listing and its deletions
      at(60 * HOUR);
      const racing = {
        ...store,
        get: async (key, ...args) => {
          if (key === SWEEP_KEY) {
            const base = await manifest.read(store);
            const next = manifest.advance(base, {
              refs: base.refs,
              packs: [orphan],
            });
            await manifest.swap({
              store,
              lock,
              base,
              next,
              uploaded: [orphan.name],
            });
          }
          return store.get(key, ...args);
        },
      };
      const result = await sweep({ store: racing, now: clock });
      expect(result.packsSpared).toBe(1);
      expect(result.packsDeleted).toBe(0);
      expect(whole(orphan)).toBe(true);
    });

    it("leaves a pack that was not there when it was marked, part of it written since, alone", async function () {
      at(25 * HOUR);
      await store.delete(revKey(orphan.name));
      await run();
      at(40 * HOUR);
      await store.put(revKey(orphan.name), Buffer.alloc(30));

      at(60 * HOUR);
      const result = await run();
      expect(result.packsSpared).toBe(1);
      expect(result.packsDeleted).toBe(0);
      expect(whole(orphan)).toBe(true);
    });

    it("deletes the uploads of a first push that never swapped", async function () {
      const empty = faults(createMemoryStore({ now: () => clock }));
      store = empty;
      inner = empty;
      await upload();
      at(25 * HOUR);
      await run();
      at(50 * HOUR);
      expect((await run()).packsDeleted).toBe(1);
      expect([...empty.objects.keys()]).toEqual([]);
    });

    it("deletes a merged-away history piece and history pack like any pack", async function () {
      const piece = await upload({ rev: false });
      await pushOf([], [piece]);
      const history = await upload({ rev: false });
      await compaction([], null, {
        history: { ...history, through: 2 },
        removePieces: [piece.name],
      });

      at(10 * DAY);
      await run({ keepManifests: 1 });
      at(12 * DAY);
      const result = await run({ keepManifests: 1 });
      expect(result.packsDeleted).toBe(2);
      expect(exists(piece)).toBe(false);
      expect(exists(orphan)).toBe(false);
      expect(whole(history)).toBe(true);
      expect(whole(named)).toBe(true);
    });

    it("never deletes a pack the newest manifest names, and says so if asked to", async function () {
      at(25 * HOUR);
      // A record which marks a named pack, as a bug might write it
      const keys = {};
      for (const ext of ["pack", "idx", "rev"])
        keys[ext] = (
          await inner.head("packs/" + named.name + "." + ext)
        ).lastModified;
      await store.put(
        SWEEP_KEY,
        Buffer.from(
          JSON.stringify({
            version: 1,
            marked: { [named.name]: { at: T0, keys } },
          })
        )
      );
      const result = await run();
      expect(result.packsDeleted).toBe(0);
      expect(result.packsSpared).toBe(1);
      expect(whole(named)).toBe(true);

      // The last check before a DELETE is an assertion
      const newest = await manifest.read(store);
      const error = await fails(
        sweep.deleteMarked(store, {
          name: named.name,
          mark: { at: T0, keys },
          newest,
        })
      );
      expect(error.code).toBe("SWEEP_REFERENCED");
      expect(whole(named)).toBe(true);
      expect(inner.objects.has(revKey(named.name))).toBe(true);
    });

    it("leaves keys it does not recognise alone", async function () {
      const others = [
        "packs/notes.txt",
        "packs/pack-abc.pack",
        "packs/" + named.name + ".keep",
        "other/thing",
        "manifests/old.json",
      ];
      for (const key of others) await store.put(key, Buffer.from("x"));
      at(30 * DAY);
      await run({ keepManifests: 1 });
      at(32 * DAY);
      await run({ keepManifests: 1 });
      for (const key of others) expect(inner.objects.has(key)).toBe(true, key);
      expect(inner.objects.has(LATEST_KEY)).toBe(true);
      expect(exists(orphan)).toBe(false);
    });

    it("can run as two sweeps at once", async function () {
      const more = [await upload(), await upload()];
      const orphans = [orphan, ...more];

      at(25 * HOUR);
      store.inject("list", { delay: 20 });
      const marking = await Promise.all([run(), run()]);
      // The slower one may find the other's record, or write over it
      expect(marking[1].packsMarked).toBe(3);
      expect(Object.keys((await record()).marked).length).toBe(3);

      at(50 * HOUR);
      store.inject("list", { delay: 20 });
      const deleting = await Promise.all([run(), run()]);
      const deleted = deleting.reduce((sum, r) => sum + r.packsDeleted, 0);
      expect(deleted).toBeGreaterThanOrEqual(3);
      expect(deleted).toBeLessThanOrEqual(6);
      for (const entry of orphans) expect(exists(entry)).toBe(false);
      expect(whole(named)).toBe(true);

      // One finishing first, then the other
      const late = await upload();
      at(80 * HOUR);
      await run();
      at(110 * HOUR);
      store.inject("list", { delay: 50 });
      const slow = run();
      const fast = await run();
      expect(fast.packsDeleted).toBe(1);
      const after = await slow;
      expect(after.packsDeleted).toBe(0);
      expect(exists(late)).toBe(false);
      expect(await record()).toBe(null);
    });

    it("throws on a failed listing, changing nothing, and the next run carries on", async function () {
      at(25 * HOUR);
      store.inject("list", { before: dropped() });
      expect((await fails(run())).code).toBe("ECONNRESET");
      expect(await record()).toBe(null);

      expect((await run()).packsMarked).toBe(1);
      at(50 * HOUR);
      store.inject("list", { after: dropped() });
      expect((await fails(run())).code).toBe("ECONNRESET");
      expect(whole(orphan)).toBe(true);
      expect((await run()).packsDeleted).toBe(1);
    });

    it("throws on a failed DELETE part way, and the next run deletes the rest", async function () {
      const second = await upload();
      at(25 * HOUR);
      await run();

      at(50 * HOUR);
      store.inject("delete", { key: idxKey(orphan.name), before: dropped() });
      expect((await fails(run())).code).toBe("ECONNRESET");
      // Its .pack and .rev went; the .idx is still as it was marked
      expect(inner.objects.has(idxKey(orphan.name))).toBe(true);
      expect(inner.objects.has(packKey(orphan.name))).toBe(false);
      expect(whole(named)).toBe(true);

      const result = await run();
      expect(exists(orphan)).toBe(false);
      expect(exists(second)).toBe(false);
      expect(result.pending).toBe(0);
      expect(await record()).toBe(null);
      expect((await manifest.read(store)).packs.map((p) => p.name)).toEqual([
        named.name,
      ]);
    });

    it("throws when its record cannot be written, deleting nothing it should not", async function () {
      at(25 * HOUR);
      store.inject("put", { key: SWEEP_KEY, before: dropped() });
      expect((await fails(run())).code).toBe("ECONNRESET");
      at(50 * HOUR);
      expect((await run()).packsDeleted).toBe(0);
      at(75 * HOUR);
      expect((await run()).packsDeleted).toBe(1);
    });

    it("treats a damaged record as empty, which only delays", async function () {
      at(25 * HOUR);
      await run();
      await store.put(SWEEP_KEY, Buffer.from("{ not json"));
      at(50 * HOUR);
      const result = await run();
      expect(result.packsDeleted).toBe(0);
      expect(result.packsMarked).toBe(1);
      at(75 * HOUR);
      expect((await run()).packsDeleted).toBe(1);
    });

    it("refuses options which would delete too soon", async function () {
      expect((await fails(run({ grace: 60 * 1000 }))).message).toMatch(/grace/);
      expect((await fails(run({ keepManifests: 0 }))).message).toMatch(
        /keepManifests/
      );
      expect((await fails(run({ recoveryWindow: -1 }))).message).toMatch(
        /recoveryWindow/
      );
      expect(exists(orphan)).toBe(true);
    });
  });

  describe("manifests", function () {
    // 30 pushes: 1 to 10 at the start, 11 to 30 six days later
    let packs;

    beforeEach(async function () {
      packs = [];
      for (let i = 1; i <= 30; i++) {
        if (i === 11) at(6 * DAY);
        packs.push(await upload());
        await pushOf([packs[i - 1]]);
      }
    });

    it("deletes those both keepManifests behind the newest and older than the recovery window", async function () {
      at(8 * DAY);
      const result = await run({ keepManifests: 5 });
      expect(result.manifestsDeleted).toBe(10);
      expect(manifestSeqs().sort((a, b) => a - b)).toEqual(
        Array.from({ length: 20 }, (_, i) => i + 11)
      );
      expect(inner.objects.has(LATEST_KEY)).toBe(true);

      // Every pack is still named by the newest
      at(20 * DAY);
      const later = await run({ keepManifests: 5 });
      expect(later.manifestsDeleted).toBe(20 - 5);
      expect(manifestSeqs().sort((a, b) => a - b)).toEqual([
        26, 27, 28, 29, 30,
      ]);
      for (const entry of packs) expect(whole(entry)).toBe(true);
    });

    it("keeps the newest keepManifests however old", async function () {
      at(100 * DAY);
      await run();
      expect(manifestSeqs().sort((a, b) => a - b)).toEqual(
        Array.from({ length: 20 }, (_, i) => i + 11)
      );
      expect(inner.objects.has(manifestKey(10))).toBe(false);
    });

    it("keeps the packs named only by manifests in the recovery window, and sweeps them once those go", async function () {
      // Packs 1 to 20 merged into one; only manifests 1 to 30 name them
      at(6 * DAY + HOUR);
      const merged = await upload();
      await compaction(packs.slice(0, 20), merged);

      at(9 * DAY);
      // 1 to 10 go; 11 to 30 are inside the window and still name them
      expect((await run({ keepManifests: 1 })).manifestsDeleted).toBe(10);
      at(11 * DAY);
      const kept = await run({ keepManifests: 1 });
      expect(kept.packsMarked).toBe(0);
      expect(kept.packsDeleted).toBe(0);
      for (const entry of packs) expect(whole(entry)).toBe(true);

      // A week after the last of them was written they go, and so do the packs
      at(14 * DAY);
      const marking = await run({ keepManifests: 1 });
      expect(marking.manifestsDeleted).toBe(20);
      expect(marking.packsMarked).toBe(20);
      at(15 * DAY);
      const deleting = await run({ keepManifests: 1 });
      expect(deleting.packsDeleted).toBe(20);
      for (const entry of packs.slice(0, 20)) expect(exists(entry)).toBe(false);
      for (const entry of [...packs.slice(20), merged])
        expect(whole(entry)).toBe(true);
      expect(manifestSeqs()).toEqual([31]);
    });

    it("leaves manifest.read working with a stale hint, a missing one, or one naming a deleted manifest", async function () {
      at(8 * DAY);
      await run({ keepManifests: 5 });

      // Another process, which holds nothing in memory
      const fresh = async () => {
        const other = createMemoryStore();
        for (const [key, bytes] of inner.objects) await other.put(key, bytes);
        return other;
      };
      expect((await manifest.read(await fresh())).seq).toBe(30);
      for (const seq of [3, 10, 11, 25]) {
        await inner.put(LATEST_KEY, Buffer.from(JSON.stringify({ seq })));
        expect((await manifest.read(await fresh())).seq).toBe(30, seq);
      }
      await inner.delete(LATEST_KEY);
      expect((await manifest.read(await fresh())).seq).toBe(30);
    });
  });

  describe("a writer that stalled past the sweep", function () {
    it("cannot create a manifest in the hole the sweep left below the newest", async function () {
      const lockOf = (fn) => fn();
      await pushOf();
      // The writer reads seq 1, and stalls
      const stalled = await manifest.read(store, { clock: () => clock });
      const theirs = manifest.advance(stalled, { refs: { [MASTER]: oid(7) } });

      // Others push 30 times, and a week and more later the sweep deletes the
      // old manifests, seq 2 among them
      for (let i = 0; i < 30; i++) await pushOf();
      at(9 * DAY);
      expect((await run()).manifestsDeleted).toBe(1 + 30 - 20);
      expect(inner.objects.has(manifestKey(2))).toBe(false);

      // The writer wakes: its base is too old, so nothing is written, and the
      // newest manifest is untouched
      const error = await fails(
        manifest.swap({
          store,
          lock: lockOf,
          base: stalled,
          next: theirs,
          clock: () => clock,
        })
      );
      expect(error && error.name).toBe("StaleManifestError");
      expect(inner.objects.has(manifestKey(2))).toBe(false);
      expect((await manifest.read(store)).seq).toBe(31);
    });

    it("cannot build on a manifest it kept in memory once the sweep has deleted it, with the hint still naming it", async function () {
      const clocked = { clock: () => clock };
      // Process A writes seq 1 and keeps its bytes
      const a = { ...inner };
      const first = await manifest.read(a, clocked);
      await manifest.swap({
        store: a,
        lock,
        base: first,
        next: manifest.advance(first, { refs: { [MASTER]: oid(1) } }),
        ...clocked,
      });

      // Others push 30 times; the hint lags at 1
      for (let i = 0; i < 30; i++) await pushOf();
      await inner.put(LATEST_KEY, Buffer.from(JSON.stringify({ seq: 1 })));

      at(9 * DAY);
      expect((await run()).manifestsDeleted).toBe(11);
      expect(inner.objects.has(manifestKey(1))).toBe(false);

      // A reads again: seq 1 is in its memory, but gone from the store
      const base = await manifest.read(a, clocked);
      expect(base.seq).toBe(31);
      await manifest.swap({
        store: a,
        lock,
        base,
        next: manifest.advance(base, { refs: { [MASTER]: oid(2) } }),
        ...clocked,
      });
      expect(inner.objects.has(manifestKey(2))).toBe(false);
      expect((await manifest.read(createMemoryStoreCopy())).seq).toBe(32);
    });

    // Another process, holding nothing in memory
    function createMemoryStoreCopy() {
      const other = createMemoryStore();
      for (const [key, bytes] of inner.objects) other.objects.set(key, bytes);
      return other;
    }

    it("requires a recovery window well over the age a swap allows its base", async function () {
      expect(sweep.MIN_RECOVERY_WINDOW).toBeGreaterThanOrEqual(
        2 * manifest.MAX_BASE_AGE
      );
      expect(
        (await fails(run({ recoveryWindow: manifest.MAX_BASE_AGE }))).message
      ).toMatch(/recoveryWindow/);
      await run({ recoveryWindow: sweep.MIN_RECOVERY_WINDOW });
    });
  });

  describe("requests", function () {
    it("finds the newest of a listing of 150,000 manifests", async function () {
      const named = await upload();
      const top = await pushOf([named]);
      // Stand-ins for the manifests below; only the newest is read
      for (let seq = 2; seq <= 150000; seq++)
        inner.objects.set(manifestKey(seq), Buffer.from("{}"));
      const newest = {
        ...top,
        seq: 150001,
        snapshots: [{ seq: 150001, refs: top.refs }],
        packs: top.packs.map((p) => ({ ...p, seq: 150001 })),
      };
      await store.put(manifestKey(150001), manifest.serialize(newest));

      at(30 * HOUR);
      const result = await run();
      expect(result.requests.gets).toBe(1);
      expect(result.manifestsDeleted).toBe(0);
      expect(whole(named)).toBe(true);
    });

    it("costs a LIST and a GET when there is nothing to do", async function () {
      const named = await upload();
      await pushOf([named]);
      await pushOf();
      at(30 * DAY);
      await run();

      const result = await run();
      expect(result.requests).toEqual({
        lists: 1,
        gets: 1,
        heads: 0,
        puts: 0,
        deletes: 0,
      });
      expect(
        result.manifestsDeleted + result.packsMarked + result.packsDeleted
      ).toBe(0);
    });

    it("reads the older kept manifests, newest first, only until the unnamed packs are found", async function () {
      const first = await upload();
      await pushOf([first]);
      for (let i = 0; i < 10; i++) await pushOf();
      const merged = await upload();
      // first is named by manifests 1 to 11, merged by 12 on
      await compaction([first], merged);
      for (let i = 0; i < 5; i++) await pushOf();

      at(2 * DAY);
      const result = await run();
      // The newest, then 16 down to 11, which names it
      expect(result.requests).toEqual({
        lists: 1,
        gets: 7,
        heads: 0,
        puts: 0,
        deletes: 0,
      });
      expect(result.packsMarked).toBe(0);
    });

    it("costs a HEAD for the next manifest and three HEADs and DELETEs for each pack it deletes", async function () {
      const named = await upload();
      await pushOf([named]);
      await upload();
      await upload();
      at(25 * HOUR);
      const marking = await run();
      expect(marking.requests).toEqual({
        lists: 1,
        gets: 1,
        heads: 0,
        puts: 1,
        deletes: 0,
      });

      at(50 * HOUR);
      const deleting = await run();
      expect(deleting.packsDeleted).toBe(2);
      // The record's GET, then for each: a HEAD forward, 3 HEADs, 3 DELETEs;
      // and the record's DELETE
      expect(deleting.requests).toEqual({
        lists: 1,
        gets: 2,
        heads: 8,
        puts: 0,
        deletes: 7,
      });
    });
  });
});

describe("git store sweep, after compacting a real repository", function () {
  timeout(180 * 1000);

  let clock;
  let dir;
  let work;
  let inner;
  let store;
  let cache;
  let received;
  let server;
  let latest;
  let counter;

  function createLock() {
    let tail = Promise.resolve();
    return (fn) => {
      const run = tail.then(fn);
      tail = run.catch(() => {});
      return run;
    };
  }
  const lock = createLock();

  const ok = (result) => {
    if (result.code !== 0) throw new Error("git failed: " + result.stderr);
    return result;
  };
  const refresh = async () => (latest = await manifest.read(store));

  async function pushes(n) {
    for (let i = 0; i < n; i++) {
      const id = ++counter;
      fs.appendFileSync(
        path.join(work, "docs", "big.txt"),
        "Edited in push " + id + "\n"
      );
      fs.writeFileSync(
        path.join(work, "posts", "new-" + id + ".md"),
        "# Post " + id + "\n"
      );
      fx.git(work, ["add", "-A"]);
      fx.git(work, ["commit", "-q", "-m", "Push " + id]);
      ok(await push(work, ["-q", received.url, "master"]));
    }
    await refresh();
  }

  beforeEach(async function () {
    clock = T0;
    counter = 0;
    dir = fx.tempDir();
    work = path.join(dir, "work");
    fx.buildFixture(work, { commits: 5, large: false });
    inner = createMemoryStore({ now: () => clock });
    store = faults(inner);
    cache = createCache({
      dir: path.join(dir, "cache"),
      maxBytes: 64 * 1024 * 1024,
    });
    received = await createReceiveServer({ store, cache, lock: createLock() });
    server = await startServer({ store, cache, manifest: () => latest });
    ok(await push(work, ["-q", received.url, "master"]));
    await pushes(6);
    for (let i = 0; i < 2; i++) {
      const result = await commit({
        store,
        cache,
        lock,
        path: "/drafts/draft-" + i + ".md",
        contents: Buffer.from("# Draft " + i + "\n"),
      });
      expect(result.changed).toBe(true);
    }
    await refresh();
    ok(
      await runGit(["pull", "-q", "--ff-only", server.url, "master"], {
        cwd: work,
      })
    );
    await pushes(4);
  });

  afterEach(async function () {
    if (server) await server.close();
    if (received) await received.close();
    server = received = null;
    fx.remove(dir);
  });

  it("deletes the merged-away packs and pieces, and the repository still clones, fscks and reads back", async function () {
    const before = await refresh();
    const result = await compact({ store, cache, lock, minPieces: 4 });
    expect(result.outcome).toBe("compacted");
    expect(result.history).toMatch(/^pack-/);
    await refresh();
    const gone = [...result.merged, ...before.historyPieces.map((p) => p.name)];
    expect(gone.length).toBeGreaterThan(8);

    // Inside the recovery window nothing goes
    clock = T0 + 2 * DAY;
    const early = await sweep({ store, now: clock });
    expect(early.packsMarked + early.manifestsDeleted).toBe(0);

    // Past it, the old manifests go (all but the compaction's, here) and the
    // packs only they named are marked, then deleted on the next run
    clock = T0 + 8 * DAY;
    const marking = await sweep({ store, now: clock, keepManifests: 1 });
    expect(marking.manifestsDeleted).toBe(latest.seq - 1);
    expect(marking.packsMarked).toBe(gone.length);
    clock = T0 + 9 * DAY;
    const deleting = await sweep({ store, now: clock, keepManifests: 1 });
    expect(deleting.packsDeleted).toBe(gone.length);
    expect(deleting.bytesFreed).toBeGreaterThan(0);

    for (const name of gone)
      expect(
        inner.objects.has(packKey(name)) || inner.objects.has(idxKey(name))
      ).toBe(false, name);
    const left = new Set(
      [...inner.objects.keys()]
        .filter((key) => key.startsWith("packs/"))
        .map((key) => key.slice(6, 51))
    );
    expect([...left].sort()).toEqual(manifest.packsNamed(latest).sort());

    // Everything git has reads back through the store as git has it
    await cache.clear();
    const reader = createReader({ store, cache, packs: latest.packs });
    const oids = fx
      .text(work, ["rev-list", "--objects", "master"])
      .split("\n")
      .map((line) => line.slice(0, 40));
    for (const [id, { type, data }] of fx.catAll(work, oids)) {
      const found = await reader.read(id);
      expect(found && found.type).toBe(type, id);
      expect(found && found.data.equals(data)).toBe(true, id);
    }

    const target = path.join(dir, "clone");
    ok(
      await runGit([
        "-c",
        "transfer.fsckObjects=true",
        "clone",
        "-q",
        server.url,
        target,
      ])
    );
    fx.git(target, ["fsck", "--strict", "--no-dangling"]);
    expect(fx.text(target, ["rev-parse", "origin/master"])).toBe(
      latest.refs[MASTER]
    );

    // And a push after it all still works, and is not swept
    await pushes(1);
    clock = T0 + 20 * DAY;
    await sweep({ store, now: clock, keepManifests: 1 });
    clock = T0 + 21 * DAY;
    const quiet = await sweep({ store, now: clock, keepManifests: 1 });
    expect(quiet.packsDeleted).toBe(0);
    ok(
      await runGit(
        [
          "-c",
          "gc.auto=0",
          "-c",
          "maintenance.auto=false",
          "pull",
          "-q",
          "--ff-only",
        ],
        { cwd: target }
      )
    );
    fx.git(target, ["fsck", "--strict", "--no-dangling"]);
  });
});
