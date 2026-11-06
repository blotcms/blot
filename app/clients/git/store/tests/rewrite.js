// Rewriting a repository so that it holds only what its refs reach, against a
// repository pushed with a real `git push`: a "secret" committed, pushed, and
// then removed by a force push of rewritten history. After the rewrite the
// secret must be in no pack the manifest names; with a purge it must be
// nowhere in the store; and no host's cache may serve it, whatever it held
// before. Pushes, Blot's commits, compaction and the sweep must go on working
// after it, and carry its epoch.
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const fx = require("./helpers/fixture");
const timeout = require("./helpers/timeout");
const faults = require("./helpers/faults");
const { createReceiveServer, push } = require("./helpers/receiveServer");
const { startServer, runGit } = require("./helpers/upload-server");
const manifest = require("../manifest");
const rewriteRepo = require("../rewrite");
const importRepo = require("../import");
const compact = require("../compact");
const sweep = require("../sweep");
const blotWrite = require("../commit");
const createCache = require("../cache");
const createMemoryStore = require("../objectStore/memory");
const createFsStore = require("../objectStore/fs");
const createReader = require("../reader");
const {
  idxKey,
  packKey,
  manifestKey,
  manifestSeq,
  packFile,
  SWEEP_KEY,
} = require("../layout");
const DAY = 24 * 60 * 60 * 1000;
const { StaleManifestError, CorruptError } = require("../errors");

const MiB = 1024 * 1024;
const SECRET = "AKIA-THE-LEAKED-KEY-0f9e8d7c6b5a";
const START = Date.UTC(2026, 10, 1);

// What the host's lock does: one swap at a time
function createLock() {
  let tail = Promise.resolve();
  return (fn) => {
    const run = tail.then(fn);
    tail = run.catch(() => {});
    return run;
  };
}

describe("git store rewrite", function () {
  timeout(180 * 1000);

  let root;
  let counter = 0;
  const open = [];

  beforeAll(function () {
    root = fx.tempDir();
  });

  afterAll(async function () {
    for (const server of open) await server.close();
    fx.remove(root);
  });

  const unique = (name) => path.join(root, name + "-" + ++counter);

  function commitFile(dir, file, contents, message) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), contents);
    fx.git(dir, ["add", "-A"]);
    fx.git(dir, ["commit", "-q", "-m", message]);
    return fx.text(dir, ["rev-parse", "HEAD"]);
  }

  async function pushed(cwd, args) {
    const result = await push(cwd, ["-q", ...args]);
    expect(result.code).toBe(0, result.stderr);
    return result;
  }

  // A repository in a memory store (whose clock is env.now), pushed to with
  // real git: a first commit tagged v1, a commit adding the secret (in a file
  // and in its message), and one more, each a push of its own; then a clone
  // taken while the secret was there, and a force push of history without it.
  async function scenario() {
    const env = { now: START, lock: createLock() };
    env.inner = createMemoryStore({ now: () => env.now });
    env.cacheDir = unique("cache");
    env.cache = createCache({ dir: env.cacheDir, maxBytes: 64 * MiB });
    env.receiver = await createReceiveServer({
      store: env.inner,
      cache: env.cache,
      lock: env.lock,
    });
    env.server = await startServer({
      store: env.inner,
      cache: env.cache,
      manifest: () => manifest.read(env.inner),
    });
    open.push(env.receiver, env.server);

    const work = (env.work = unique("work"));
    fs.mkdirSync(work);
    fx.git(work, ["init", "-q", "-b", "master"]);
    env.first = commitFile(work, "a.md", "# One\n", "First");
    fx.git(work, ["tag", "-a", "v1", "-m", "Version 1"]);
    await pushed(work, [env.receiver.url, "master", "refs/tags/v1"]);
    // As a writer that read the first manifest and stalled holds it
    env.early = await manifest.read({ ...env.inner });
    env.now += 1000;

    env.secretCommit = commitFile(
      work,
      "keys/secret.txt",
      SECRET + "\n",
      "Add the key " + SECRET
    );
    env.secretBlob = fx.text(work, ["rev-parse", "HEAD:keys/secret.txt"]);
    env.secretTree = fx.text(work, ["rev-parse", "HEAD:keys"]);
    await pushed(work, [env.receiver.url, "master"]);
    env.now += 1000;

    commitFile(work, "a.md", "# One, edited\n", "Third");
    await pushed(work, [env.receiver.url, "master"]);
    env.now += 1000;

    env.oldClone = unique("old-clone");
    const cloned = await runGit(["clone", "-q", env.server.url, env.oldClone]);
    expect(cloned.code).toBe(0, cloned.stderr);

    // The scrub: history from the first commit again, without the secret
    fx.git(work, ["reset", "-q", "--hard", env.first]);
    commitFile(work, "b.md", "# Two\n", "Second, again");
    env.tip = commitFile(work, "a.md", "# One, edited again\n", "Third, again");
    await pushed(work, ["--force", env.receiver.url, "master"]);
    env.now += 10 * 1000;

    env.before = await manifest.read(env.inner);
    return env;
  }

  const rewrite = (env, options = {}) =>
    rewriteRepo({
      store: env.inner,
      cache: env.cache,
      lock: env.lock,
      ...options,
    });

  async function oidsInPack(store, name) {
    const idx = await store.get(idxKey(name));
    const { ids, count } = compact.git.idsOf(idx, name);
    return Array.from({ length: count }, (_, i) =>
      ids.subarray(i * 20, i * 20 + 20).toString("hex")
    );
  }

  // The objects the manifest's packs hold, by ID
  async function named(store, m) {
    const all = new Set();
    for (const name of manifest.packsNamed(m))
      for (const oid of await oidsInPack(store, name)) all.add(oid);
    return all;
  }

  // Every object in every pack file in the store, named or not, indexed
  // afresh by git: { oids, contents } where contents is every object's bytes
  async function everything(store) {
    const repo = unique("scan.git");
    fx.git(root, ["init", "-q", "--bare", repo]);
    let n = 0;
    for await (const { key } of store.list("")) {
      const file = packFile(key);
      if (!file || file.ext !== "pack") continue;
      const target = path.join(
        repo,
        "objects",
        "pack",
        "scan-" + ++n + ".pack"
      );
      fs.writeFileSync(target, await store.get(key));
      fx.git(repo, ["index-pack", target]);
    }
    const listing = n
      ? fx.text(repo, [
          "cat-file",
          "--batch-all-objects",
          "--batch-check=%(objectname)",
        ])
      : "";
    const contents = n
      ? fx.git(repo, ["cat-file", "--batch-all-objects", "--batch"])
      : Buffer.alloc(0);
    return {
      packs: n,
      oids: new Set(listing.split("\n").filter(Boolean)),
      contents,
    };
  }

  // Every key's raw bytes, for what is not a pack
  async function rawBytes(store) {
    const out = [];
    for await (const { key } of store.list("")) {
      if (packFile(key)) continue;
      out.push({ key, bytes: await store.get(key) });
    }
    return out;
  }

  // Every object the work repository's refs reach reads back through the store
  // as git has it
  async function expectReadable(env, m) {
    const reader = createReader({
      store: env.inner,
      cache: env.cache,
      manifest: m,
    });
    const oids = fx
      .text(env.work, ["rev-list", "--objects", "--branches", "--tags"])
      .split("\n")
      .map((line) => line.slice(0, 40));
    const oracle = fx.catAll(env.work, oids);
    for (const [oid, { type, data }] of oracle) {
      const found = await reader.read(oid);
      expect(found && found.type).toBe(type, oid);
      expect(found && found.data.equals(data)).toBe(true, oid);
    }
  }

  // A real clone of the store, under transfer.fsckObjects, passes git fsck
  // --strict and has the manifest's refs
  async function expectClone(env, m) {
    const target = unique("clone");
    const cloned = await runGit([
      "-c",
      "transfer.fsckObjects=true",
      "clone",
      "-q",
      env.server.url,
      target,
    ]);
    expect(cloned.code).toBe(0, cloned.stderr);
    fx.git(target, ["fsck", "--strict", "--no-dangling"]);
    expect(fx.text(target, ["rev-parse", "refs/remotes/origin/master"])).toBe(
      m.refs["refs/heads/master"]
    );
    expect(fx.text(target, ["rev-parse", "refs/tags/v1"])).toBe(
      m.refs["refs/tags/v1"]
    );
    return target;
  }

  describe("the manifest", function () {
    const base = () =>
      manifest.advance(manifest.empty(), {
        refs: { "refs/heads/master": "a".repeat(40) },
        head: "refs/heads/master",
        packs: [
          {
            name: "pack-" + "1".repeat(40),
            size: 100,
            idxSize: 1100,
            objects: 3,
          },
        ],
      });

    it("accepts an epoch, refuses one that is not a nonce, and reads a manifest without one as epoch ''", function () {
      expect(manifest.epochOf(base())).toBe("");
      expect(() =>
        manifest.validate({ ...base(), epoch: "abc123" })
      ).not.toThrow();
      expect(() => manifest.validate({ ...base(), epoch: "" })).toThrowError(
        CorruptError
      );
      expect(() =>
        manifest.validate({ ...base(), epoch: "not/a nonce" })
      ).toThrowError(CorruptError);
      expect(() => manifest.validate({ ...base(), epoch: 7 })).toThrowError(
        CorruptError
      );
    });

    it("is carried unchanged by advance and compacted, and survives serialising", function () {
      const m = { ...base(), epoch: "e1" };
      const pushed = manifest.advance(m, {
        refs: { "refs/heads/master": "b".repeat(40) },
      });
      expect(pushed.epoch).toBe("e1");
      const merged = manifest.compacted(pushed, {});
      expect(merged.epoch).toBe("e1");
      expect(manifest.parse(manifest.serialize(merged)).epoch).toBe("e1");
      expect("epoch" in manifest.advance(base(), { refs: {} })).toBe(false);
    });

    it("rewritten keeps refs, head and peeled, names one pack and the history, and snapshots only the refs now", function () {
      const tag = "c".repeat(40);
      const m = {
        ...manifest.advance(base(), {
          refs: { "refs/heads/master": "a".repeat(40), "refs/tags/v1": tag },
          peeled: { [tag]: "a".repeat(40) },
        }),
        historyPieces: [
          {
            name: "pack-" + "2".repeat(40),
            size: 40,
            idxSize: 1100,
            objects: 1,
            seq: 2,
          },
        ],
      };
      const pack = {
        name: "pack-" + "3".repeat(40),
        size: 90,
        idxSize: 1100,
        objects: 4,
        extra: true,
      };
      const history = {
        name: "pack-" + "4".repeat(40),
        size: 50,
        idxSize: 1100,
        objects: 1,
      };
      const next = manifest.rewritten(m, { epoch: "e2", pack, history });
      expect(next.seq).toBe(3);
      expect(next.epoch).toBe("e2");
      expect(next.writer).not.toBe(m.writer);
      expect(next.refs).toEqual(m.refs);
      expect(next.head).toBe(m.head);
      expect(next.peeled).toEqual(m.peeled);
      expect(next.packs).toEqual([
        { name: pack.name, size: 90, idxSize: 1100, objects: 4, seq: 3 },
      ]);
      expect(next.history).toEqual({ ...history, through: 3 });
      expect(next.historyPieces).toEqual([]);
      expect(next.snapshots).toEqual([{ seq: 3, refs: m.refs }]);
      expect(() => manifest.validate(next)).not.toThrow();
      expect(() =>
        manifest.rewritten(next, { epoch: "e2", pack, history })
      ).toThrow();
    });
  });

  describe("a repository with a secret scrubbed from its history", function () {
    let env;
    let result;
    let after;
    let warm; // what host A's reader read before the rewrite

    beforeAll(async function () {
      env = await scenario();

      // Host A reads the secret's commit and tree before the rewrite, so its
      // cache holds them under the old epoch (receive put them there too)
      const reader = createReader({
        store: env.inner,
        cache: env.cache,
        manifest: env.before,
      });
      warm = {
        commit: await reader.read(env.secretCommit),
        tree: await reader.read(env.secretTree),
        blob: await reader.read(env.secretBlob),
      };

      result = await rewrite(env);
      after = await manifest.read(env.inner);
    });

    it("swaps in one pack, a history pack and one snapshot, with the same refs, head and peeled, and a new epoch", function () {
      expect(warm.commit.data.toString()).toContain(SECRET);
      expect(warm.blob.data.toString()).toContain(SECRET);

      expect(result.outcome).toBe("rewritten");
      expect(result.seq).toBe(env.before.seq + 1);
      expect(after.seq).toBe(result.seq);
      expect(after.epoch).toBe(result.epoch);
      expect(result.epoch).toMatch(/^[0-9a-f]{16}$/);
      expect(after.refs).toEqual(env.before.refs);
      expect(after.refs["refs/heads/master"]).toBe(env.tip);
      expect(after.head).toBe(env.before.head);
      expect(after.peeled).toEqual(env.before.peeled);
      expect(Object.keys(after.peeled).length).toBe(1);
      expect(after.packs.length).toBe(1);
      expect(after.packs[0].seq).toBe(after.seq);
      expect(after.history.through).toBe(after.seq);
      expect(after.historyPieces).toEqual([]);
      expect(after.snapshots).toEqual([{ seq: after.seq, refs: after.refs }]);
    });

    it("reports what it dropped", function () {
      expect(result.before.packs).toBe(manifest.packsNamed(env.before).length);
      expect(result.after).toEqual({
        packs: 2,
        bytes:
          after.packs[0].size +
          after.packs[0].idxSize +
          after.history.size +
          after.history.idxSize,
        objects: after.packs[0].objects,
      });
      // The secret's blob, its tree, the root trees and commits of the old
      // second and third commits
      expect(result.dropped.objects).toBe(
        result.before.objects - result.after.objects
      );
      expect(result.dropped.objects).toBeGreaterThanOrEqual(5);
      expect(result.purged).toEqual({
        packs: 0,
        bytes: 0,
        spared: 0,
        missing: [],
      });
      expect(result.stats.attempts).toBe(1);
    });

    it("leaves the secret in no pack the manifest names, and nothing else out", async function () {
      const objects = await named(env.inner, after);
      for (const oid of [env.secretCommit, env.secretTree, env.secretBlob])
        expect(objects.has(oid)).toBe(false, oid);

      const reachable = fx
        .text(env.work, ["rev-list", "--objects", "--branches", "--tags"])
        .split("\n")
        .map((line) => line.slice(0, 40));
      expect(new Set(await oidsInPack(env.inner, after.packs[0].name))).toEqual(
        new Set(reachable)
      );
    });

    it("leaves the old packs in the store for the sweep, so without a purge the secret is still there", async function () {
      for (const name of manifest.packsNamed(env.before))
        expect(await env.inner.head(packKey(name))).not.toBeNull();
      const scan = await everything(env.inner);
      expect(scan.oids.has(env.secretBlob)).toBe(true);
    });

    it("reads every object back as git has it", async function () {
      await expectReadable(env, after);
    });

    it("serves a clone that passes git fsck --strict, with the refs", async function () {
      const target = await expectClone(env, after);
      expect(fs.existsSync(path.join(target, "keys", "secret.txt"))).toBe(
        false
      );
      const cat = await runGit(["cat-file", "-e", env.secretBlob], {
        cwd: target,
      });
      expect(cat.code).not.toBe(0);
    });

    it("sends a client which cloned before the rewrite everything, and it fetches cleanly", async function () {
      const results = env.server.results.length;
      const fetched = await runGit(
        ["-c", "transfer.fsckObjects=true", "fetch", "-q", "origin"],
        { cwd: env.oldClone }
      );
      expect(fetched.code).toBe(0, fetched.stderr);
      const served = env.server.results.slice(results);
      expect(served.length).toBeGreaterThan(0);
      expect(served[served.length - 1].floor).toBe(0);
      fx.git(env.oldClone, ["fsck", "--strict", "--no-dangling"]);
      expect(
        fx.text(env.oldClone, ["rev-parse", "refs/remotes/origin/master"])
      ).toBe(env.tip);
    });

    it("serves nothing cached before the rewrite, on this host or another sharing only the store and the cache directory", async function () {
      // Host A, reading the new manifest
      const mine = createReader({
        store: env.inner,
        cache: env.cache,
        manifest: after,
      });
      for (const oid of [env.secretCommit, env.secretTree, env.secretBlob])
        expect(await mine.read(oid)).toBeNull(oid);

      // Host B: its own view of the store (the same keys and id) and its own
      // cache instance over the same directory, so it finds what A wrote there
      const elsewhere = { ...env.inner };
      const theirs = createCache({ dir: env.cacheDir, maxBytes: 64 * MiB });
      const current = await manifest.read(elsewhere);
      expect(current.epoch).toBe(result.epoch);
      const reader = createReader({
        store: elsewhere,
        cache: theirs,
        manifest: current,
      });
      for (const oid of [env.secretCommit, env.secretTree, env.secretBlob]) {
        expect(await reader.read(oid)).toBeNull(oid);
        const streamed = await reader.stream(oid);
        expect(streamed).toBeNull(oid);
      }

      // What B was protected from: the old entries are still in the shared
      // cache, under the old epoch, and a reader that ignored the epoch would
      // serve them though the packs no longer hold them
      const careless = createReader({
        store: elsewhere,
        cache: theirs,
        packs: current.packs,
        epoch: "",
      });
      const found = await careless.read(env.secretCommit);
      expect(found && found.data.toString()).toContain(SECRET);
    });

    it("leaves a single pack for compaction to leave alone", async function () {
      const outcome = await compact({
        store: env.inner,
        cache: env.cache,
        lock: env.lock,
      });
      expect(outcome.outcome).toBe("nothing");
    });
  });

  describe("with a purge", function () {
    let env;
    let result;
    let after;
    let manifestsBefore; // seq -> bytes

    beforeAll(async function () {
      env = await scenario();
      await env.inner.put(
        SWEEP_KEY,
        Buffer.from(JSON.stringify({ version: 1, marked: {} }))
      );
      manifestsBefore = new Map();
      for (let seq = 1; seq <= env.before.seq; seq++)
        manifestsBefore.set(seq, await env.inner.get(manifestKey(seq)));
      result = await rewrite(env, { purge: true });
      after = await manifest.read(env.inner);
    });

    it("deletes every pack the new manifest does not name, and the sweep's record", async function () {
      expect(result.outcome).toBe("rewritten");
      const before = manifest.packsNamed(env.before);
      expect(result.purged.packs).toBe(before.length);
      expect(result.purged.bytes).toBeGreaterThan(0);
      expect(result.purged.spared).toBe(0);
      expect(result.purged.missing).toEqual([]);

      const left = new Set();
      for await (const { key } of env.inner.list("packs/"))
        left.add(packFile(key).name);
      expect([...left].sort()).toEqual(manifest.packsNamed(after).sort());
      expect(await env.inner.head(SWEEP_KEY)).toBeNull();
    });

    it("leaves every older manifest as it was: they hold refs and IDs, not content", async function () {
      expect("manifests" in result.purged).toBe(false);
      for (const [seq, bytes] of manifestsBefore)
        expect((await env.inner.get(manifestKey(seq))).equals(bytes)).toBe(
          true,
          seq
        );
    });

    it("leaves the secret's bytes nowhere in the store", async function () {
      const scan = await everything(env.inner);
      expect(scan.packs).toBe(2);
      for (const oid of [env.secretCommit, env.secretTree, env.secretBlob])
        expect(scan.oids.has(oid)).toBe(false, oid);
      expect(scan.contents.includes(SECRET)).toBe(false);

      // The old manifests are still there, with object IDs in them, but no
      // key holds the secret itself
      for (const { key, bytes } of await rawBytes(env.inner))
        expect(bytes.includes(SECRET)).toBe(false, key);
    });

    it("still reads, clones and fetches", async function () {
      await expectReadable(env, after);
      await expectClone(env, after);
      const fetched = await runGit(["fetch", "-q", "origin"], {
        cwd: env.oldClone,
      });
      expect(fetched.code).toBe(0, fetched.stderr);
      fx.git(env.oldClone, ["fsck", "--strict", "--no-dangling"]);
    });

    it("leaves a writer which read an old manifest no hole to create into", async function () {
      const early = env.early;
      expect(early.seq).toBeLessThan(env.before.seq);
      expect(manifest.isFresh(early)).toBe(true);
      const next = manifest.advance(early, {
        refs: {
          ...early.refs,
          "refs/tags/late": early.refs["refs/heads/master"],
        },
      });
      const error = await manifest
        .swap({ store: { ...env.inner }, lock: env.lock, base: early, next })
        .catch((err) => err);
      expect(error instanceof StaleManifestError).toBe(true);
      expect(
        (await env.inner.get(manifestKey(early.seq + 1))).equals(
          manifestsBefore.get(early.seq + 1)
        )
      ).toBe(true);
      expect((await manifest.read(env.inner)).seq).toBe(after.seq);
    });
  });

  describe("the sweep after a purge", function () {
    it("ages the old manifests out in order, taking the packs they name that are gone as deleted", async function () {
      const env = await scenario();
      const result = await rewrite(env, { purge: true });
      const after = await manifest.read(env.inner);
      // Twenty more manifests, so the old ones are below the ones kept
      for (let i = 0; i < 20; i++) {
        env.now += 1000;
        const out = await blotWrite({
          store: env.inner,
          cache: env.cache,
          lock: env.lock,
          path: "note-" + i + ".md",
          contents: Buffer.from("note " + i + "\n"),
        });
        expect(out.outcome).toBe("ok");
      }

      // Inside the window the old manifests are kept, and so read, and the
      // packs they name are not there: nothing to mark, nothing fails
      env.now += DAY;
      const early = await sweep({ store: env.inner, now: env.now });
      expect(early.manifestsDeleted).toBe(0);
      expect(early.packsMarked).toBe(0);
      expect(early.packsDeleted).toBe(0);

      env.now += 7 * DAY;
      const swept = await sweep({ store: env.inner, now: env.now });
      expect(swept.manifestsDeleted).toBeGreaterThanOrEqual(after.seq - 1);
      for (let seq = 1; seq < after.seq; seq++)
        expect(await env.inner.head(manifestKey(seq))).toBeNull();
      expect((await manifest.read(env.inner)).epoch).toBe(result.epoch);
      await expectClone(env, await manifest.read(env.inner));
    });
  });

  describe("purge on its own", function () {
    it("spares a pack written after the rewrite, and is safe to run again", async function () {
      const env = await scenario();
      const result = await rewrite(env);
      const ours = await manifest.read(env.inner);

      // A pack uploaded after the rewrite's manifest, which some writer
      // building on it may be about to name
      env.now += 5000;
      fx.repackAll(env.work);
      const [late] = fx.readPacks(env.work);
      await env.inner.put(packKey(late.name), late.pack);
      await env.inner.put(idxKey(late.name), late.idx);

      const purged = await rewriteRepo.purge({ store: env.inner, ours });
      expect(purged.packs).toBe(manifest.packsNamed(env.before).length);
      expect(purged.spared).toBe(1);
      expect(await env.inner.head(packKey(late.name))).not.toBeNull();
      expect(result.outcome).toBe("rewritten");

      const again = await rewriteRepo.purge({ store: env.inner, ours });
      expect(again.packs).toBe(0);
      expect(again.spared).toBe(1);
      expect(again.missing).toEqual([]);
      await expectClone(env, ours);
    });
  });

  describe("racing other writers", function () {
    it("reports a pack re-uploaded and named between a HEAD and its DELETE as damaged", async function () {
      const env = await scenario();
      await rewrite(env);
      const ours = await manifest.read(env.inner);

      // The first push's pack, which a push after the rewrite uploads again,
      // byte for byte, and names (a force push back to that history, say)
      const old = env.before.packs.find((pack) => pack.seq === 1);
      const bytes = {
        pack: await env.inner.get(packKey(old.name)),
        idx: await env.inner.get(idxKey(old.name)),
      };
      const store = faults(env.inner).inject("delete", {
        key: packKey(old.name),
        delay: 200,
      });

      const purging = rewriteRepo.purge({ store, ours });
      while (!store.calls.includes("delete " + packKey(old.name)))
        await new Promise((resolve) => setTimeout(resolve, 5));

      // In the window: the HEAD has passed, the DELETE has not been sent
      env.now += 5000;
      await env.inner.put(packKey(old.name), bytes.pack);
      await env.inner.put(idxKey(old.name), bytes.idx);
      const base = await manifest.read(env.inner);
      await manifest.swap({
        store: env.inner,
        lock: env.lock,
        base,
        next: manifest.advance(base, { refs: base.refs, packs: [old] }),
      });

      const purged = await purging;
      expect(purged.missing).toEqual([old.name]);
      expect(await env.inner.head(packKey(old.name))).toBeNull();
      // The .idx, written after the cutoff, was spared
      expect(await env.inner.head(idxKey(old.name))).not.toBeNull();
    });

    it("answers damaged, and the command line would exit 3, when the check after the purge finds a pack missing", async function () {
      const env = await scenario();
      // A store whose final HEADs say the rewritten pack is gone
      let rewritten = null;
      const store = faults(env.inner);
      const wrapped = {
        ...store,
        putIfAbsent: async (key, buffer) => {
          const created = await env.inner.putIfAbsent(key, buffer);
          rewritten = manifest.parse(buffer);
          store.inject("head", {
            key: packKey(rewritten.packs[0].name),
            answer: null,
            skip: 0,
          });
          return created;
        },
      };
      const result = await rewriteRepo({
        store: wrapped,
        cache: env.cache,
        lock: env.lock,
        purge: true,
      });
      expect(result.outcome).toBe("damaged");
      expect(result.purged.missing).toEqual([rewritten.packs[0].name]);
    });

    it("includes a push that lands while it works, by doing it again", async function () {
      const env = await scenario();
      let tip = null;
      const racing = {
        ...env.inner,
        putIfAbsent: async (key, buffer) => {
          if (!tip && manifestSeq(key) !== null) {
            tip = commitFile(
              env.work,
              "racing.md",
              "# Pushed during the rewrite\n",
              "Racing"
            );
            await pushed(env.work, [env.receiver.url, "master"]);
          }
          return env.inner.putIfAbsent(key, buffer);
        },
      };

      // Its own lock: the push runs inside the rewrite's swap
      const result = await rewriteRepo({
        store: racing,
        cache: env.cache,
        lock: (fn) => fn(),
        purge: true,
      });
      expect(result.outcome).toBe("rewritten");
      expect(result.stats.attempts).toBe(2);

      const after = await manifest.read(env.inner);
      expect(after.seq).toBe(env.before.seq + 2);
      expect(after.refs["refs/heads/master"]).toBe(tip);
      expect(after.packs.length).toBe(1);
      expect(
        (await named(env.inner, after)).has(
          fx.text(env.work, ["rev-parse", "HEAD:racing.md"])
        )
      ).toBe(true);
      expect((await everything(env.inner)).oids.has(env.secretBlob)).toBe(
        false
      );
      await expectReadable(env, after);
      const target = await expectClone(env, after);
      expect(fs.readFileSync(path.join(target, "racing.md"), "utf8")).toContain(
        "during the rewrite"
      );
    });

    it("builds the manifest again, and nothing else, when only a compaction landed", async function () {
      const env = await scenario();
      let compacted = null;
      const racing = {
        ...env.inner,
        putIfAbsent: async (key, buffer) => {
          if (!compacted && manifestSeq(key) !== null)
            compacted = await compact({
              store: env.inner,
              cache: env.cache,
              lock: env.lock,
              keepRecent: 0,
            });
          return env.inner.putIfAbsent(key, buffer);
        },
      };
      const result = await rewriteRepo({
        store: racing,
        cache: env.cache,
        lock: (fn) => fn(),
      });
      expect(compacted.outcome).toBe("compacted");
      expect(result.outcome).toBe("rewritten");
      expect(result.stats.attempts).toBe(2);
      expect(result.stats.requests.puts).toBe(5 + 1); // one set of uploads, and the hint after the swap that landed
      const after = await manifest.read(env.inner);
      expect(after.seq).toBe(env.before.seq + 2);
      await expectClone(env, after);
    });

    it("refuses a push whose swap comes after a rewrite, and takes it when pushed again", async function () {
      const env = await scenario();
      let rewritten = null;
      const racing = {
        ...env.inner,
        putIfAbsent: async (key, buffer) => {
          if (!rewritten && manifestSeq(key) !== null) {
            env.now += 2000;
            rewritten = await rewrite(env, { purge: true });
          }
          return env.inner.putIfAbsent(key, buffer);
        },
      };
      // Its own lock: the rewrite runs inside the push's swap
      const server = await createReceiveServer({
        store: racing,
        cache: env.cache,
        lock: (fn) => fn(),
      });
      open.push(server);

      const tip = commitFile(
        env.work,
        "late.md",
        "# Pushed as the rewrite landed\n",
        "Late"
      );
      const refused = await push(env.work, ["-q", server.url, "master"]);
      expect(refused.code).not.toBe(0);
      expect(refused.stderr).toContain("moved");
      expect(rewritten.outcome).toBe("rewritten");
      expect(server.results[0].outcome).toBe("refused");

      const after = await manifest.read(env.inner);
      expect(after.seq).toBe(rewritten.seq);
      expect(after.refs["refs/heads/master"]).toBe(env.tip);

      await pushed(env.work, [env.receiver.url, "master"]);
      const latest = await manifest.read(env.inner);
      expect(latest.refs["refs/heads/master"]).toBe(tip);
      expect(latest.epoch).toBe(rewritten.epoch);
      await expectReadable(env, latest);
      await expectClone(env, latest);
    });

    it("uploads a Blot commit's pack again when a purging rewrite lands before its swap", async function () {
      const env = await scenario();
      let rewritten = null;
      const racing = {
        ...env.inner,
        putIfAbsent: async (key, buffer) => {
          if (!rewritten && manifestSeq(key) !== null) {
            env.now += 2000;
            rewritten = await rewrite(env, { purge: true });
          }
          return env.inner.putIfAbsent(key, buffer);
        },
      };
      const puts = env.inner.stats.puts;
      const out = await blotWrite({
        store: racing,
        cache: env.cache,
        lock: (fn) => fn(),
        path: "from-blot.md",
        contents: Buffer.from("written by Blot\n"),
      });
      expect(out.outcome).toBe("ok");
      expect(rewritten.purged.packs).toBeGreaterThan(
        manifest.packsNamed(env.before).length
      );

      const after = await manifest.read(env.inner);
      expect(after.seq).toBe(rewritten.seq + 1);
      expect(after.epoch).toBe(rewritten.epoch);
      for (const name of manifest.packsNamed(after)) {
        expect(await env.inner.head(packKey(name))).not.toBeNull(name);
        expect(await env.inner.head(idxKey(name))).not.toBeNull(name);
      }
      expect(env.inner.stats.puts - puts).toBeGreaterThan(5 * 2);
      const target = await expectClone(env, after);
      expect(fs.readFileSync(path.join(target, "from-blot.md"), "utf8")).toBe(
        "written by Blot\n"
      );
    });

    it("lets a compaction which read the manifest before the rewrite give up as superseded", async function () {
      const env = await scenario();
      let rewritten = null;
      const racing = {
        ...env.inner,
        putIfAbsent: async (key, buffer) => {
          if (!rewritten && manifestSeq(key) !== null)
            rewritten = await rewrite(env);
          return env.inner.putIfAbsent(key, buffer);
        },
      };
      const outcome = await compact({
        store: racing,
        cache: env.cache,
        lock: (fn) => fn(),
        keepRecent: 0,
      });
      expect(outcome.outcome).toBe("superseded");
      expect((await manifest.read(env.inner)).seq).toBe(rewritten.seq);
    });
  });

  describe("after a rewrite", function () {
    it("takes pushes, Blot's commits, compaction and the sweep, which carry the epoch, and is refused by import", async function () {
      const env = await scenario();
      const rewritten = await rewrite(env, { purge: true });

      commitFile(env.work, "after.md", "# After\n", "After the rewrite");
      await pushed(env.work, [env.receiver.url, "master"]);
      let m = await manifest.read(env.inner);
      expect(m.seq).toBe(rewritten.seq + 1);
      expect(m.epoch).toBe(rewritten.epoch);
      expect(m.snapshots.length).toBe(2);

      for (let i = 0; i < 3; i++) {
        env.now += 1000;
        const out = await blotWrite({
          store: env.inner,
          cache: env.cache,
          lock: env.lock,
          path: "blot-" + i + ".md",
          contents: Buffer.from("blot " + i + "\n"),
        });
        expect(out.outcome).toBe("ok");
      }
      m = await manifest.read(env.inner);
      expect(m.epoch).toBe(rewritten.epoch);
      // Not fx.git, which would block the server in this process
      const pulled = await runGit(
        [
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.com",
          "pull",
          "-q",
          "--no-rebase",
          env.server.url,
          "master",
        ],
        { cwd: env.work }
      );
      expect(pulled.code).toBe(0, pulled.stderr);
      await expectReadable(env, m);

      const compacted = await compact({
        store: env.inner,
        cache: env.cache,
        lock: env.lock,
        keepRecent: 0,
        minPieces: 2,
      });
      expect(compacted.outcome).toBe("compacted");
      m = await manifest.read(env.inner);
      expect(m.epoch).toBe(rewritten.epoch);
      expect(m.packs.length).toBe(1);
      await expectReadable(env, m);
      await expectClone(env, m);

      // The manifests before the compaction leave the window, then what they
      // named is marked, then deleted a grace later
      env.now += 3 * DAY;
      const marking = await sweep({
        store: env.inner,
        now: env.now,
        recoveryWindow: 2 * DAY,
        keepManifests: 1,
      });
      expect(marking.packsMarked).toBeGreaterThan(0);
      env.now += 2 * DAY;
      const swept = await sweep({
        store: env.inner,
        now: env.now,
        recoveryWindow: 2 * DAY,
        keepManifests: 1,
      });
      expect(swept.packsDeleted).toBe(marking.packsMarked);
      m = await manifest.read(env.inner);
      expect(m.epoch).toBe(rewritten.epoch);
      const left = new Set();
      for await (const { key } of env.inner.list("packs/"))
        left.add(packFile(key).name);
      expect([...left].sort()).toEqual(manifest.packsNamed(m).sort());
      await expectClone(env, m);

      const error = await importRepo({
        store: env.inner,
        cache: env.cache,
        lock: env.lock,
        gitDir: path.join(env.work, ".git"),
      }).catch((err) => err);
      expect(error.code).toBe("ENOTEMPTY");

      const again = await rewrite(env);
      expect(again.outcome).toBe("rewritten");
      expect(again.epoch).not.toBe(rewritten.epoch);
      expect(again.dropped.objects).toBe(0);
    });

    it("rewrites an imported repository, whose manifest has no epoch", async function () {
      const env = await scenario();
      const store = createMemoryStore();
      const imported = await importRepo({
        store,
        cache: env.cache,
        lock: env.lock,
        gitDir: path.join(env.work, ".git"),
      });
      expect(imported.outcome).toBe("imported");
      expect(manifest.epochOf(await manifest.read(store))).toBe("");
      const out = await rewriteRepo({
        store,
        cache: env.cache,
        lock: env.lock,
        purge: true,
      });
      expect(out.outcome).toBe("rewritten");
      expect(out.dropped.objects).toBe(0);
      expect((await manifest.read(store)).epoch).toBe(out.epoch);
    });
  });

  describe("a dry run", function () {
    it("writes nothing, and reports what a rewrite and a purge would drop", async function () {
      const env = await scenario();
      const before = { ...env.inner.stats };
      const dry = await rewrite(env, { dryRun: true, purge: true });
      expect(dry.outcome).toBe("dry-run");
      expect(env.inner.stats.puts).toBe(before.puts);
      expect(env.inner.stats.putIfAbsents).toBe(before.putIfAbsents);
      expect(env.inner.stats.deletes).toBe(before.deletes);
      expect(await manifest.read(env.inner)).toEqual(env.before);
      expect(dry.seq).toBe(env.before.seq);
      expect(Object.keys(dry.wouldPurge).sort()).toEqual(["bytes", "packs"]);
      expect(dry.wouldPurge.packs).toBe(manifest.packsNamed(env.before).length);
      expect(env.cache.stats().reservedBytes).toBe(0);

      const real = await rewrite(env, { purge: true });
      expect(real.dropped).toEqual(dry.dropped);
      expect(real.before).toEqual(dry.before);
      expect(real.purged.packs).toBe(dry.wouldPurge.packs);
      expect(real.purged.bytes).toBe(dry.wouldPurge.bytes);
    });

    it("works in a scratch directory of its own, and removes it", async function () {
      const env = await scenario();
      const scratchDir = unique("scratch");
      const out = await rewriteRepo({
        store: env.inner,
        lock: env.lock,
        scratchDir,
        dryRun: true,
      });
      expect(out.outcome).toBe("dry-run");
      expect(fs.readdirSync(scratchDir)).toEqual([]);
    });
  });

  describe("an ordinary push", function () {
    it("makes the same requests after a rewrite as before one", async function () {
      const source = unique("source");
      fs.mkdirSync(source);
      fx.git(source, ["init", "-q", "-b", "master"]);
      commitFile(source, "a.md", "# One\n", "First");
      commitFile(source, "docs/b.md", "# Two\n", "Second");

      const used = [];
      for (const rewriteIt of [false, true]) {
        const store = createMemoryStore();
        const cache = createCache({ dir: unique("cache"), maxBytes: 64 * MiB });
        const lock = createLock();
        await importRepo({
          store,
          cache,
          lock,
          gitDir: path.join(source, ".git"),
        });
        if (rewriteIt)
          expect(
            (await rewriteRepo({ store, cache, lock, purge: true })).outcome
          ).toBe("rewritten");

        const client = unique("client");
        fx.git(root, [
          "clone",
          "-q",
          "--no-hardlinks",
          path.join(source, ".git"),
          client,
        ]);
        commitFile(client, "docs/b.md", "# Two, edited\n", "Edit");

        // A fresh cache and server, so neither starts warm
        const fresh = createCache({ dir: unique("cache"), maxBytes: 64 * MiB });
        const server = await createReceiveServer({ store, cache: fresh, lock });
        open.push(server);
        const start = { ...store.stats };
        await pushed(client, [server.url, "master"]);
        used.push(
          Object.fromEntries(
            [
              "heads",
              "reads",
              "gets",
              "puts",
              "putIfAbsents",
              "lists",
              "deletes",
            ].map((key) => [key, store.stats[key] - start[key]])
          )
        );
        if (rewriteIt)
          expect((await manifest.read(store)).epoch).toMatch(/^[0-9a-f]{16}$/);
      }
      expect(used[1]).toEqual(used[0]);
    });
  });

  describe("the operator script", function () {
    const script = path.join(
      __dirname,
      "..",
      "..",
      "..",
      "..",
      "..",
      "scripts",
      "git",
      "rewrite-repo.js"
    );

    function run(args) {
      return new Promise((resolve) => {
        execFile(
          process.execPath,
          [script, ...args],
          { maxBuffer: 1 << 24 },
          (err, stdout, stderr) => {
            resolve({
              code: err ? err.code : 0,
              stdout: String(stdout),
              stderr: String(stderr),
            });
          }
        );
      });
    }

    it("dry runs, rewrites and purges a repository in a local folder, printing JSON", async function () {
      const dir = unique("fs-store");
      const store = createFsStore({ root: dir });
      const source = unique("source");
      fs.mkdirSync(source);
      fx.git(source, ["init", "-q", "-b", "master"]);
      const first = commitFile(source, "a.md", "# One\n", "First");
      commitFile(source, "secret.txt", SECRET + "\n", "Secret");
      const cache = createCache({ dir: unique("cache"), maxBytes: 64 * MiB });
      await importRepo({
        store,
        cache,
        lock: (fn) => fn(),
        gitDir: path.join(source, ".git"),
      });

      fx.git(source, ["reset", "-q", "--hard", first]);
      commitFile(source, "b.md", "# Two\n", "Second, again");
      const server = await createReceiveServer({
        store,
        cache,
        lock: (fn) => fn(),
      });
      open.push(server);
      await pushed(source, ["--force", server.url, "master"]);
      // The purge only deletes what was written in a second before the rewrite
      await new Promise((resolve) => setTimeout(resolve, 1100));

      const listing = () => {
        const out = [];
        (function walk(at) {
          for (const name of fs.readdirSync(at).sort()) {
            const file = path.join(at, name);
            if (fs.statSync(file).isDirectory()) walk(file);
            else
              out.push(
                path.relative(dir, file) + ":" + fs.statSync(file).mtimeMs
              );
          }
        })(dir);
        return out;
      };
      const before = listing();

      const dry = await run(["--dir", dir, "--dry-run", "--purge"]);
      expect(dry.code).toBe(0, dry.stderr);
      const planned = JSON.parse(dry.stdout);
      expect(planned.outcome).toBe("dry-run");
      expect(planned.dropped.objects).toBeGreaterThan(0);
      expect(planned.wouldPurge.packs).toBeGreaterThan(0);
      expect(listing()).toEqual(before);

      const done = await run(["--dir", dir, "--purge"]);
      expect(done.code).toBe(0, done.stderr);
      const result = JSON.parse(done.stdout);
      expect(result.outcome).toBe("rewritten");
      expect(result.purged.packs).toBe(planned.wouldPurge.packs);
      const m = await manifest.read(createFsStore({ root: dir }));
      expect(m.epoch).toBe(result.epoch);
      expect(
        (await everything(createFsStore({ root: dir }))).contents.includes(
          SECRET
        )
      ).toBe(false);

      const refused = await run(["--purge"]);
      expect(refused.code).toBe(1);
      expect(refused.stderr).toContain("Give a target");
    });
  });
});
