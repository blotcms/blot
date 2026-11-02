// Compaction, against real repositories: pushes go in with a real `git push`
// through receive(), with some of Blot's own commits between them, then
// compact() merges the packs and the history pieces. Afterwards every object
// read through the store must match `git cat-file`, a real `git clone` must
// pass `transfer.fsckObjects` and `git fsck --strict` with the server's refs,
// and fetches from clients one and several pushes behind must still get only
// the small packs of the pushes they lack. The plan, and manifest.compacted,
// are also tested on their own.
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
const createCache = require("../cache");
const createMemoryStore = require("../objectStore/memory");
const createReader = require("../reader");
const { readHistory } = require("../history");
const { negotiate } = require("../fetch");
const { manifestKey, idxKey, revKey, packKey } = require("../layout");
const { OutcomeUnknownError, StaleManifestError, NoRoomError } = require("../errors");
const { buildRev } = require("../rev");

const MiB = 1024 * 1024;
const MASTER = "refs/heads/master";

const dropped = () => Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });

function createLock() {
  let tail = Promise.resolve();
  return (fn) => {
    const run = tail.then(fn);
    tail = run.catch(() => {});
    return run;
  };
}

// A manifest entry, for the plan's specs
const pack = (n, size, seq) => ({ name: "pack-" + String(n).padStart(40, "0"), size, idxSize: 1100, objects: 3, seq });

function manifestWith(packs, pieces = 0) {
  const seq = Math.max(1, ...packs.map((p) => p.seq));
  return {
    ...manifest.empty(),
    seq,
    writer: "test",
    packs,
    historyPieces: Array.from({ length: pieces }, (_, i) => ({ ...pack(1000 + i, 200, Math.min(seq, i + 1)) })),
  };
}

describe("git store compaction plan", function () {
  it("merges the small packs below the base, leaving the newest pushes' packs alone", function () {
    const m = manifestWith([pack(1, 1000000, 1), ...[2, 3, 4, 5, 6, 7, 8, 9].map((seq) => pack(seq, 1000 + seq, seq))]);
    const chosen = compact.plan(m);
    expect(chosen.history).toBe(false);
    // 6 to 9 are the newest four
    expect(chosen.packs.sort()).toEqual([2, 3, 4, 5].map((n) => pack(n).name));
  });

  it("finds the smallest split that leaves every pack above it at least twice everything below", function () {
    // Sorted: 10, 12, 30, 100, 1000. 30 < 2 * 22, so 10, 12 and 30 go; then
    // 100 >= 2 * 52 fails too (100 < 104), so it goes as well; 1000 stays
    const m = manifestWith([pack(1, 1000, 1), pack(2, 100, 2), pack(3, 30, 3), pack(4, 12, 4), pack(5, 10, 5)]);
    const chosen = compact.plan(m, { keepRecent: 0 });
    expect(chosen.packs.sort()).toEqual([2, 3, 4, 5].map((n) => pack(n).name));

    // Already geometric: nothing to do
    const geometric = manifestWith([pack(1, 1000, 1), pack(2, 300, 2), pack(3, 100, 3), pack(4, 30, 4), pack(5, 10, 5)]);
    expect(compact.plan(geometric, { keepRecent: 0 })).toBe(null);

    // A larger factor merges more
    expect(compact.plan(geometric, { keepRecent: 0, factor: 4 }).packs.length).toBe(5);
  });

  it("does not merge a single pack, nor touch the newest packs however small", function () {
    expect(compact.plan(manifestWith([pack(1, 1000, 1), pack(2, 10, 2)]), { keepRecent: 0 })).toBe(null);
    const m = manifestWith([pack(1, 1000, 1), pack(2, 10, 2), pack(3, 10, 3), pack(4, 10, 4)]);
    expect(compact.plan(m, { keepRecent: 3 })).toBe(null);
    expect(compact.plan(m, { keepRecent: 2 })).toBe(null);
    expect(compact.plan(m, { keepRecent: 1 }).packs.length).toBe(2);
  });

  it("counts the newest pushes by seq, so packs sharing one are kept together", function () {
    const m = manifestWith([pack(1, 1000, 1), pack(2, 10, 2), pack(3, 10, 3), pack(4, 10, 3), pack(5, 10, 4)]);
    expect(compact.plan(m, { keepRecent: 2 })).toBe(null);
    expect(compact.plan(m, { keepRecent: 1 }).packs.sort()).toEqual([2, 3, 4].map((n) => pack(n).name));
  });

  it("ignores keepRecent past maxPacks, so a burst of pushes cannot leave many packs", function () {
    const many = [pack(1, 100000, 1), ...Array.from({ length: 40 }, (_, i) => pack(i + 2, 500, i + 2))];
    const chosen = compact.plan(manifestWith(many));
    expect(chosen.packs.length).toBe(40);
    expect(compact.plan(manifestWith(many.slice(0, 33))).packs.length).toBe(32);
    expect(compact.plan(manifestWith(many.slice(0, 32))).packs.length).toBe(27);
  });

  it("never takes in more than maxBytes, leaving a base pack bigger than that alone", function () {
    // The base is under twice the rest, so the geometric split takes it too
    const m = manifestWith([pack(1, 500, 1), pack(2, 100, 2), pack(3, 100, 3), pack(4, 100, 4), pack(5, 100, 5)]);
    expect(compact.plan(m, { keepRecent: 0 }).packs.length).toBe(5);

    // Each small pack is 100 bytes and a 1100-byte .idx
    expect(compact.plan(m, { keepRecent: 0, maxBytes: 5000 }).packs.sort()).toEqual([2, 3, 4, 5].map((n) => pack(n).name));
    expect(compact.plan(m, { keepRecent: 0, maxBytes: 2500 }).packs.length).toBe(2);
    expect(compact.plan(m, { keepRecent: 0, maxBytes: 1300 })).toBe(null);
  });

  it("merges the small packs that fit past maxPacks, leaving a big base", function () {
    const many = [pack(1, 15000, 1), ...Array.from({ length: 40 }, (_, i) => pack(i + 2, 500, i + 2))];
    expect(compact.plan(manifestWith(many)).packs.length).toBe(41);

    const chosen = compact.plan(manifestWith(many), { maxBytes: 40 * 1600 });
    expect(chosen.packs.length).toBe(40);
    expect(chosen.packs).not.toContain(pack(1).name);
    expect(compact.plan(manifestWith(many), { maxBytes: 10 * 1600 }).packs.length).toBe(10);
  });

  it("does not count packs too big to merge towards maxPacks, so keepRecent still protects the newest", function () {
    // 50 full packs (2000 bytes and a 1100-byte .idx, over half of maxBytes),
    // then six small recent ones
    const full = Array.from({ length: 50 }, (_, i) => pack(i + 1, 2000, i + 1));
    const small = Array.from({ length: 6 }, (_, i) => pack(i + 51, 50, i + 51));
    const chosen = compact.plan(manifestWith([...full, ...small]), { maxBytes: 5000 });

    // The newest four (53 to 56) are kept; the two older small ones merge
    expect(chosen.packs.sort()).toEqual([51, 52].map((n) => pack(n).name));
  });

  it("rebuilds the history once there are enough pieces", function () {
    expect(compact.plan(manifestWith([pack(1, 1000, 1)], 15))).toBe(null);
    expect(compact.plan(manifestWith([pack(1, 1000, 1)], 16))).toEqual({ packs: [], history: true });
    expect(compact.plan(manifestWith([pack(1, 1000, 1)], 3), { minPieces: 3 })).toEqual({ packs: [], history: true });
  });

  it("has nothing to do for an empty repository", function () {
    expect(compact.plan(manifest.empty())).toBe(null);
  });
});

describe("git store manifest.compacted", function () {
  it("replaces the inputs with the merged pack at the largest of their seqs, in seq order, changing nothing else", function () {
    const base = {
      ...manifestWith([pack(1, 1000, 1), pack(2, 100, 2), pack(3, 100, 3), pack(4, 100, 4), pack(5, 100, 5)], 3),
      refs: { [MASTER]: "a".repeat(40) },
      head: MASTER,
      snapshots: [{ seq: 5, refs: { [MASTER]: "a".repeat(40) } }],
      peeled: {},
    };
    const merged = { name: pack(9).name, size: 250, idxSize: 1200, objects: 6 };
    const next = manifest.compacted(base, { remove: [pack(2).name, pack(3).name], add: merged });

    expect(next.seq).toBe(6);
    expect(next.writer).not.toBe(base.writer);
    expect(next.packs.map((p) => [p.name, p.seq])).toEqual([
      [pack(1).name, 1],
      [pack(9).name, 3],
      [pack(4).name, 4],
      [pack(5).name, 5],
    ]);
    for (const field of ["refs", "head", "snapshots", "peeled", "history", "historyPieces"]) expect(next[field]).toEqual(base[field]);
    manifest.validate(next);
  });

  it("swaps the history pack and drops only the pieces it merged", function () {
    const base = manifestWith([pack(1, 1000, 1), pack(2, 10, 2), pack(3, 10, 3)], 3);
    const history = { name: pack(8).name, size: 300, idxSize: 1100, objects: 2, through: 2 };
    const next = manifest.compacted(base, { history, removePieces: base.historyPieces.slice(0, 2).map((p) => p.name) });
    expect(next.history).toEqual(history);
    expect(next.historyPieces).toEqual([base.historyPieces[2]]);
    expect(next.packs).toEqual(base.packs);
  });

  it("refuses inputs which are no longer listed", function () {
    const base = manifestWith([pack(1, 1000, 1), pack(2, 10, 2)]);
    expect(() => manifest.compacted(base, { remove: [pack(7).name], add: pack(9) })).toThrowError(StaleManifestError);
    expect(() => manifest.compacted(base, { removePieces: [pack(7).name], history: null })).toThrowError(StaleManifestError);
  });
});

describe("git store compaction", function () {
  timeout(180 * 1000);

  let dir;
  let work;
  let inner;
  let store;
  let cache;
  let lock;
  let received;
  let server;
  let latest;
  let counter;

  async function setup({ maxBytes = 64 * MiB } = {}) {
    dir = fx.tempDir();
    work = path.join(dir, "work");
    counter = 0;
    fx.buildFixture(work, { commits: 5, large: false });

    inner = createMemoryStore();
    store = faults(inner);
    cache = createCache({ dir: path.join(dir, "cache"), maxBytes });
    lock = createLock();
    received = await createReceiveServer({ store, cache, lock: createLock() });
    server = await startServer({ store, cache, manifest: () => latest });
    await pushWork();
  }

  async function teardown() {
    if (server) await server.close();
    if (received) await received.close();
    server = received = null;
    fx.remove(dir);
  }

  const refresh = async () => (latest = await manifest.read(store));

  function ok(result) {
    if (result.code !== 0) throw new Error("git failed: " + result.stderr);
    return result;
  }

  async function pushWork() {
    ok(await push(work, ["-q", received.url, "master"]));
    await refresh();
  }

  // Pushes `n` commits, one push each, each editing a file git deltas against
  // an older pack (so the thin pack's base is appended, and held twice)
  async function pushes(n) {
    for (let i = 0; i < n; i++) {
      const id = ++counter;
      fs.appendFileSync(path.join(work, "docs", "big.txt"), "Edited in push " + id + "\n");
      fs.writeFileSync(path.join(work, "posts", "new-" + id + ".md"), "# Post " + id + "\n\nWritten for push " + id + "\n");
      fx.git(work, ["add", "-A"]);
      fx.git(work, ["commit", "-q", "-m", "Push " + id]);
      await pushWork();
    }
  }

  // Blot's own commits, which the writer then pulls so its next push builds on them
  async function blotCommits(n) {
    for (let i = 0; i < n; i++) {
      const id = ++counter;
      const result = await commit({ store, cache, lock, path: "/drafts/draft-" + id + ".md", contents: Buffer.from("# Draft " + id + "\n") });
      expect(result.changed).toBe(true);
    }
    await refresh();
    ok(await runGit(["pull", "-q", "--ff-only", server.url, "master"], { cwd: work }));
  }

  async function clone(name) {
    const target = path.join(dir, name);
    ok(await runGit(["-c", "transfer.fsckObjects=true", "clone", "-q", server.url, target]));
    return target;
  }

  // A client's refs are the server's, and git is satisfied with what it got
  function expectMirror(client) {
    fx.git(client, ["fsck", "--strict", "--no-dangling"]);
    const found = {};
    for (const line of fx.text(client, ["for-each-ref", "--format=%(objectname) %(refname)", "refs/remotes/origin", "refs/tags"]).split("\n").filter(Boolean)) {
      const [oid, ref] = line.split(" ");
      if (ref !== "refs/remotes/origin/HEAD") found[ref] = oid;
    }
    const expected = {};
    for (const [ref, oid] of Object.entries(latest.refs)) {
      expected[ref.startsWith("refs/heads/") ? "refs/remotes/origin/" + ref.slice(11) : ref] = oid;
    }
    expect(found).toEqual(expected);
  }

  // Every object of the writer's master (which is the server's) reads back
  // through the store as git reads it
  async function expectObjects() {
    const reader = createReader({ store, cache, packs: latest.packs });
    expect(fx.text(work, ["rev-parse", "master"])).toBe(latest.refs[MASTER]);
    const oids = fx.text(work, ["rev-list", "--objects", "master"]).split("\n").map((line) => line.slice(0, 40));
    const oracle = fx.catAll(work, oids);
    for (const [oid, { type, data }] of oracle) {
      const found = await reader.read(oid);
      expect(found && found.type).toBe(type, oid);
      expect(found && found.data.equals(data)).toBe(true, oid);
    }
    return oracle.size;
  }

  // The requests a cold clone makes of the store
  async function cloneRequests(name) {
    await cache.clear();
    const before = { ...inner.stats };
    const target = await clone(name);
    expectMirror(target);
    return inner.stats.heads + inner.stats.reads + inner.stats.gets - (before.heads + before.reads + before.gets);
  }

  const lastResult = () => server.results[server.results.length - 1];

  // IDs held in more than one of the manifest's packs
  async function duplicates() {
    const seen = new Map();
    for (const p of latest.packs) {
      const idx = await store.get(idxKey(p.name));
      const count = idx.readUInt32BE(8 + 255 * 4);
      for (let i = 0; i < count; i++) {
        const oid = idx.toString("hex", 1032 + i * 20, 1052 + i * 20);
        seen.set(oid, (seen.get(oid) || 0) + 1);
      }
    }
    return [...seen].filter(([, n]) => n > 1).map(([oid]) => oid);
  }

  describe("a repository of many pushes and Blot commits", function () {
    beforeEach(async function () {
      await setup();
      await pushes(6);
      await blotCommits(3);
      await pushes(6);
    });
    afterEach(teardown);

    it("merges the packs and pieces, losing no object, and clones with fewer requests", async function () {
      const packsBefore = latest.packs.length;
      const piecesBefore = latest.historyPieces.length;
      const requestsBefore = await cloneRequests("before");
      const dupes = await duplicates();
      expect(dupes.length).toBeGreaterThan(0);

      const result = await compact({ store, cache, lock, minPieces: 8 });
      await refresh();

      expect(result.outcome).toBe("compacted");
      expect(result.seq).toBe(latest.seq);
      expect(result.merged.length).toBeGreaterThan(5);
      expect(latest.packs.length).toBe(packsBefore - result.merged.length + 1);
      expect(latest.packs.map((p) => p.name)).toContain(result.into);
      expect(result.stats.objectsOut).toBeLessThanOrEqual(result.stats.objectsIn);

      // The merged pack has a .rev that matches its index, and is self-contained
      const idx = await store.get(idxKey(result.into));
      expect((await store.get(revKey(result.into))).equals(buildRev(idx))).toBe(true);

      // The history: one pack of every commit, no pieces
      expect(latest.historyPieces).toEqual([]);
      expect(latest.history.name).toBe(result.history);
      expect(result.stats.piecesIn).toBe(piecesBefore);
      const graph = await readHistory({ store, manifest: latest });
      expect(graph.size).toBe(Number(fx.text(work, ["rev-list", "--count", "--all"])));

      // No snapshot was added: the refs did not change
      expect(latest.snapshots[latest.snapshots.length - 1].seq).toBe(latest.seq - 1);

      // The objects held twice before read back as git has them, and the clone
      // (which skips duplicates) is still whole
      await expectObjects();
      const requestsAfter = await cloneRequests("after");
      expect(requestsAfter).toBeLessThan(requestsBefore);
      expect(latest.packs.every((p, i) => i === 0 || latest.packs[i - 1].seq <= p.seq)).toBe(true);

      // Run again: nothing more is worth doing
      const again = await compact({ store, cache, lock, minPieces: 8 });
      expect(again.outcome).toBe("nothing");
    });

    it("still sends a client one push behind, and one several behind, only the small packs it lacks", async function () {
      const several = await clone("several");
      await pushes(2);
      const one = await clone("one");
      await pushes(1);

      const result = await compact({ store, cache, lock });
      expect(result.outcome).toBe("compacted");
      await refresh();

      ok(await runGit(["-c", "transfer.fsckObjects=true", "fetch", "-q", "origin"], { cwd: one }));
      expect(lastResult().packs).toBe(1);
      expect(lastResult().objects).toBeLessThan(10);
      expectMirror(one);

      ok(await runGit(["-c", "transfer.fsckObjects=true", "fetch", "-q", "origin"], { cwd: several }));
      expect(lastResult().packs).toBe(3);
      expect(lastResult().objects).toBeLessThan(25);
      expectMirror(several);
      expect(lastResult().packs).toBeLessThan(latest.packs.length);
    });

    it("keeps fetch's ancestor walk working once the pieces are merged into the history pack", async function () {
      // A push of two commits, so the first is no snapshot's tip
      fs.writeFileSync(path.join(work, "posts", "middle.md"), "Middle\n");
      fx.git(work, ["add", "-A"]);
      fx.git(work, ["commit", "-q", "-m", "Middle"]);
      const middle = fx.text(work, ["rev-parse", "HEAD"]);
      await pushes(1);
      const first = fx.text(work, ["rev-list", "--max-parents=0", "master"]);

      const result = await compact({ store, cache, lock, minPieces: 1 });
      expect(result.history).toMatch(/^pack-/);
      await refresh();
      expect(latest.historyPieces).toEqual([]);

      // The walk from it reaches the tip of the push before
      const negotiation = await negotiate({ store, cache, manifest: latest, haves: [middle] });
      expect(negotiation.walked).toBeGreaterThan(1);
      expect(negotiation.floor).toBe(latest.snapshots[latest.snapshots.length - 2].seq);

      // And a push after it adds a piece the next walk reads alongside the pack
      await pushes(1);
      expect(latest.historyPieces.length).toBe(1);
      const graph = await readHistory({ store, manifest: latest });
      expect(graph.has(latest.refs[MASTER])).toBe(true);
      expect(graph.has(first)).toBe(true);
    });
  });

  describe("against pushes and other compactions", function () {
    beforeEach(async function () {
      await setup();
      await pushes(10);
    });
    afterEach(teardown);

    // Makes `competing` happen once, just before compaction's first swap
    function raceOnce(competing) {
      let raced = false;
      return async (fn) => {
        if (!raced) {
          raced = true;
          await competing();
        }
        return lock(fn);
      };
    }

    it("builds again on the new manifest when a push lands between its read and its swap", async function () {
      const result = await compact({ store, cache, lock: raceOnce(() => pushes(1)) });
      expect(result.outcome).toBe("compacted");
      expect(result.stats.attempts).toBe(2);

      await refresh();
      expect(latest.refs[MASTER]).toBe(fx.text(work, ["rev-parse", "HEAD"]));
      expect(latest.packs.map((p) => p.name)).toContain(result.into);
      for (const name of result.merged) expect(latest.packs.map((p) => p.name)).not.toContain(name);
      // The push's own pack is the newest, unmerged
      expect(latest.packs[latest.packs.length - 1].seq).toBe(latest.seq - 1);

      await expectObjects();
      expectMirror(await clone("after"));
    });

    it("is superseded when another compaction removes its inputs first", async function () {
      let winner;
      const result = await compact({ store, cache, lock: raceOnce(async () => (winner = await compact({ store, cache, lock }))) });

      expect(winner.outcome).toBe("compacted");
      expect(result.outcome).toBe("superseded");
      await refresh();
      expect(latest.seq).toBe(winner.seq);
      expect(latest.packs.map((p) => p.name)).toContain(winner.into);
      expectMirror(await clone("after"));
    });

    it("takes the moved seq of an input that a push listed again", async function () {
      const chosen = compact.plan(latest);
      const moved = latest.packs.find((p) => p.name === chosen.packs[0]);

      // As receive does when a push's pack is one already listed
      const racing = raceOnce(async () => {
        const base = await manifest.read(store);
        const { name, size, idxSize, objects } = moved;
        const next = manifest.advance(base, { refs: base.refs, packs: [{ name, size, idxSize, objects }] });
        await manifest.swap({ store, lock, base, next });
      });

      const result = await compact({ store, cache, lock: racing });
      expect(result.outcome).toBe("compacted");
      await refresh();

      const merged = latest.packs.find((p) => p.name === result.into);
      expect(merged.seq).toBe(latest.seq - 1);
      expect(latest.packs[latest.packs.length - 1].name).toBe(result.into);
      expectMirror(await clone("after"));
    });
  });

  describe("when the store fails", function () {
    beforeEach(async function () {
      await setup();
      await pushes(8);
    });
    afterEach(teardown);

    it("leaves the manifest as it was after a crash between the uploads and the swap, and a rerun works", async function () {
      const before = await manifest.read(store);
      store.inject("putIfAbsent", { key: manifestKey(before.seq + 1), before: dropped() });

      const error = await compact({ store, cache, lock }).then(() => null, (err) => err);
      expect(error.code).toBe("ECONNRESET");
      expect(await manifest.read(store)).toEqual(before);

      const again = await compact({ store, cache, lock });
      expect(again.outcome).toBe("compacted");
      expect(again.seq).toBe(before.seq + 1);
      // The same pack, made again and uploaded over itself
      const puts = store.calls.filter((call) => call === "put " + packKey(again.into));
      expect(puts.length).toBe(2);

      await refresh();
      await expectObjects();
      expectMirror(await clone("after"));
    });

    it("returns an unknown outcome when the swap cannot be read back, and the manifest says which", async function () {
      const before = await manifest.read(store);
      const key = manifestKey(before.seq + 1);
      store.inject("putIfAbsent", { key, after: dropped() }).inject("get", { key, before: dropped() });

      const result = await compact({ store, cache, lock });
      expect(result.outcome).toBe("unknown");
      expect(result.error).toEqual(jasmine.any(OutcomeUnknownError));

      // It landed: reading back finds it
      await refresh();
      expect(latest.seq).toBe(result.seq);
      expect(latest.packs.map((p) => p.name)).toContain(result.into);
      expect((await compact({ store, cache, lock })).outcome).toBe("nothing");
    });

    it("fails with NoRoomError, changing nothing, when the cache has no room for its scratch space", async function () {
      const before = await manifest.read(store);
      const small = createCache({ dir: path.join(dir, "small"), maxBytes: 1024 });
      const error = await compact({ store, cache: small, lock, maxBytes: Infinity }).then(() => null, (err) => err);
      expect(error).toEqual(jasmine.any(NoRoomError));
      expect(await manifest.read(store)).toEqual(before);

      // Left to size merges by the cache, it finds nothing small enough to do
      expect((await compact({ store, cache: small, lock })).outcome).toBe("nothing");
    });

    it("merges the small packs of a repository larger than its cache, leaving the big one", async function () {
      fs.writeFileSync(path.join(work, "photo.jpg"), fx.bytes(9, 2 * MiB));
      fx.git(work, ["add", "-A"]);
      fx.git(work, ["commit", "-q", "-m", "A big file"]);
      await pushWork();
      const big = latest.packs[latest.packs.length - 1];
      expect(big.size).toBeGreaterThan(2 * MiB);
      await pushes(8);

      // A quarter of a 1 MiB cache: the big pack can never be an input, though
      // the geometric split alone (with a factor large enough) would take it
      const small = createCache({ dir: path.join(dir, "small"), maxBytes: 1 * MiB });
      expect(compact.plan(latest, { factor: 100, maxBytes: Infinity }).packs).toContain(big.name);

      const before = latest.packs.length;
      const result = await compact({ store, cache: small, lock, factor: 100 });
      expect(result.outcome).toBe("compacted");
      expect(result.merged).not.toContain(big.name);
      expect(result.stats.bytesIn).toBeLessThan(256 * 1024);

      await refresh();
      expect(latest.packs.length).toBe(before - result.merged.length + 1);
      expect(latest.packs.map((p) => p.name)).toContain(big.name);
      await expectObjects();
      expectMirror(await clone("after"));
    });

    it("refuses an input that is not the size the manifest says, changing nothing", async function () {
      const before = await manifest.read(store);
      store.inject("stream", { key: /\.pack$/, truncate: 40 });
      const error = await compact({ store, cache, lock }).then(() => null, (err) => err);
      expect(error.code).toBe("CORRUPT");
      expect(await manifest.read(store)).toEqual(before);
    });
  });
});
