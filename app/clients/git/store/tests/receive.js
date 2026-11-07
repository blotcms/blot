// Receiving a push, against real repositories and a real `git push`. The
// repository in the store starts as a few commits of the standard fixture; the
// client is that fixture's working directory, so what it sends is a genuine
// thin pack built against what the server advertised.
const fs = require("fs");
const path = require("path");
const { Readable } = require("stream");
const fx = require("./helpers/fixture");
const faults = require("./helpers/faults");
const timeout = require("./helpers/timeout");
const { createReceiveServer, push } = require("./helpers/receiveServer");
const manifest = require("../manifest");
const receive = require("../receive");
const blotWrite = require("../commit");
const createCache = require("../cache");
const createMemoryStore = require("../objectStore/memory");
const createReader = require("../reader");
const {
  LATEST_KEY,
  manifestKey,
  packKey,
  idxKey,
  revKey,
} = require("../layout");

const ZERO = "0".repeat(40);
const MASTER = "refs/heads/master";
const MiB = 1024 * 1024;

const dropped = () =>
  Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });

// What the host's lock does: one swap at a time
function createLock() {
  let tail = Promise.resolve();
  return (fn) => {
    const run = tail.then(fn);
    tail = run.catch(() => {});
    return run;
  };
}

const bodyOf = (buffer) => Readable.from([buffer]);

describe("git store receive", function () {
  timeout(60 * 1000);

  let dir;
  let src;
  let fixture;
  let store;
  let cache;
  let lock;
  let server;

  // Puts the fixture's history in the store as a repository would hold it
  async function seed(target) {
    fx.repackAll(src);
    const packs = fx.readPacks(src);
    expect(packs.length).toBe(1);

    const entry = await fx.upload(
      target,
      packs[0],
      fx.listEntries(packs[0]).length
    );
    const base = manifest.empty();
    const next = manifest.advance(base, {
      refs: { [MASTER]: fixture.head, "refs/tags/v1": fixture.tag },
      head: MASTER,
      packs: [entry],
    });
    await manifest.swap({ store: target, lock, base, next });
  }

  async function setup({
    wrap = (s) => s,
    maxBytes = 64 * MiB,
    limit,
    prepare,
  } = {}) {
    dir = fx.tempDir();
    src = path.join(dir, "src");
    fixture = fx.buildFixture(src, { commits: 4, large: false });
    if (prepare) {
      prepare(src);
      fixture.head = fx.text(src, ["rev-parse", "HEAD"]);
    }
    store = wrap(createMemoryStore());
    cache = createCache({ dir: path.join(dir, "cache"), maxBytes });
    lock = createLock();
    await seed(store);
    server = await createReceiveServer({ store, cache, lock, limit });
  }

  async function teardown() {
    if (server) await server.close();
    server = null;
    fx.remove(dir);
  }

  // The scratch space a push used is gone, and the budget it held is back
  function expectNoScratch() {
    const scratch = path.join(dir, "cache", "scratch");
    expect(fs.existsSync(scratch) ? fs.readdirSync(scratch) : []).toEqual([]);
    expect(cache.stats().reservedBytes).toBe(0);
  }

  // The keys under packs/ now
  async function packKeys() {
    const keys = [];
    for await (const { key } of store.list("packs/")) keys.push(key);
    return keys;
  }

  // A refused push changed nothing a reader sees: the manifest is `before`,
  // and nothing it wrote (a refused push's uploads start before its checks
  // end) is named by any manifest. What it wrote is an orphan for the sweep.
  async function expectNothingNamed(before, keysBefore) {
    const current = await manifest.read(store);
    expect(current).toEqual(before);
    const named = new Set(
      [
        ...current.packs,
        ...(current.historyPieces || []),
        ...(current.history ? [current.history] : []),
      ].flatMap((pack) => [
        packKey(pack.name),
        idxKey(pack.name),
        revKey(pack.name),
      ])
    );
    const written = (await packKeys()).filter(
      (key) => !keysBefore.includes(key)
    );
    expect(written.filter((key) => named.has(key))).toEqual([]);
    return written;
  }

  // Commits a change on the client, on a branch of its own off master, and
  // returns the commit. Without a file, edits one line of a tracked file.
  function commit(
    branch,
    change = () =>
      fs.writeFileSync(
        path.join(src, "docs", "big.txt"),
        fs
          .readFileSync(path.join(src, "docs", "big.txt"), "utf8")
          .replace("line 3 ", "line 3 edited by " + branch + " ")
      )
  ) {
    fx.git(src, ["checkout", "-q", "-B", branch, fixture.head]);
    change();
    fx.git(src, ["add", "-A"]);
    fx.git(src, ["commit", "-q", "-m", "Change from " + branch]);
    return fx.text(src, ["rev-parse", "HEAD"]);
  }

  // A thin pack of `tip` against the fixture's head, as a push would send it
  const thin = (tip) => fx.packRevs(src, [tip], [fixture.head], { thin: true });

  const update = (tip, ref = MASTER, old = fixture.head) => ({
    old,
    new: tip,
    ref,
  });

  function direct(commands, pack, options = {}) {
    return receive({
      store,
      cache,
      lock,
      commands,
      pack: pack ? bodyOf(pack) : null,
      ...options,
    });
  }

  // Every object reachable from `tip` reads back from the store's packs
  async function expectReadable(current, tip) {
    const reader = createReader({ store, cache, packs: current.packs });
    const oids = fx
      .text(src, ["rev-list", "--objects", tip])
      .split("\n")
      .map((line) => line.split(" ")[0]);
    const expected = fx.catAll(src, oids);

    for (const oid of oids) {
      const found = await reader.read(oid);
      expect(found).not.toBeNull(oid);
      expect(found.type).toBe(expected.get(oid).type);
      expect(found.data.equals(expected.get(oid).data)).toBe(true);
    }
  }

  // Rebuilds the repository from what the store holds and has git check it
  async function expectFsck(current, tip) {
    const check = path.join(dir, "check.git");
    fx.git(dir, ["init", "-q", "--bare", check]);
    for (const pack of current.packs) {
      const target = path.join(check, "objects", "pack", pack.name);
      fs.writeFileSync(target + ".pack", await store.get(packKey(pack.name)));
      fs.writeFileSync(target + ".idx", await store.get(idxKey(pack.name)));
    }
    fx.git(check, ["update-ref", MASTER, tip]);
    fx.git(check, ["fsck", "--strict", "--no-dangling"]);
    fs.rmSync(check, { recursive: true, force: true });
  }

  describe("a push from a real git client", function () {
    beforeEach(() => setup());
    afterEach(teardown);

    it("takes a thin pack, completes it, and swaps the manifest", async function () {
      const tip = commit("work");
      const before = await manifest.read(store);

      const pushed = await push(src, [server.url, "work:master"]);
      expect(pushed.stderr).toContain("master");
      expect(pushed.code).toBe(0);

      const result = server.results[0];
      expect(result.outcome).toBe("ok");
      expect(result.stats.basesFetched).toBeGreaterThan(0);

      const current = await manifest.read(store);
      expect(current.seq).toBe(before.seq + 1);
      expect(current.refs[MASTER]).toBe(tip);
      expect(current.refs["refs/tags/v1"]).toBe(fixture.tag);
      expect(current.packs.length).toBe(before.packs.length + 1);

      await expectReadable(current, tip);
      await expectFsck(current, tip);
      expectNoScratch();
    });

    it("writes a reverse index, and a history piece of just the push's commits", async function () {
      const tip = commit("work");
      expect((await push(src, [server.url, "work:master"])).code).toBe(0);

      const current = await manifest.read(store);
      const added = current.packs[current.packs.length - 1];
      expect((await store.get(revKey(added.name))).length).toBe(
        12 + 4 * added.objects + 40
      );

      expect(current.historyPieces.length).toBe(1);
      const piece = current.historyPieces[0];
      expect(piece.seq).toBe(current.seq);
      expect(piece.objects).toBe(1);

      const entries = fx.listEntries({
        pack: await store.get(packKey(piece.name)),
        idx: await store.get(idxKey(piece.name)),
      });
      expect(entries.map((e) => [e.oid, e.type])).toEqual([[tip, "commit"]]);
      // A piece is read whole, so it has no reverse index
      expect(await store.head(revKey(piece.name))).toBeNull();
    });

    it("makes a one-file push in a small, fixed number of requests", async function () {
      commit("work");
      const before = { ...store.stats };
      expect((await push(src, [server.url, "work:master"])).code).toBe(0);

      const used = Object.fromEntries(
        Object.keys(before).map((key) => [key, store.stats[key] - before[key]])
      );

      // The manifest: read at the start and again before the swap (the hint,
      // a HEAD for what follows it, the manifest itself), then the swap
      expect(used.lists).toBe(0);
      expect(used.putIfAbsents).toBe(1);

      // The pack, its index and reverse index, the history piece and its index, and the hint
      expect(used.puts).toBe(6);

      // Everything else is looking, 10 requests where it was 18: the
      // advertisement's manifest read (the hint, a HEAD for what follows it
      // and the manifest), receive's own (the hint and a HEAD, run together,
      // the manifest's bytes kept), the pack's index read whole (one GET, no
      // HEAD) and a HEAD for the pack, and the entries read for the bases, the
      // parent commit and the trees the new commit changed. None of it grows
      // with the repository's history.
      const reading = used.heads + used.reads + used.gets;
      expect(used.gets).toBe(3);
      expect(used.heads).toBe(3);
      expect(used.reads).toBe(4);
      expect(reading).toBe(10);
    });

    it("answers before the hint is written, and another process's read straight after still sees the push", async function () {
      // Another process on the same objects, warm
      const other = { ...store };
      const before = await manifest.read(other);

      // The hint lands only once the push has been answered
      const real = store.put;
      let land;
      const landed = new Promise((resolve) => (land = resolve));
      spyOn(store, "put").and.callFake(async (key, body) => {
        if (key === LATEST_KEY) await landed;
        return real(key, body);
      });

      const tip = commit("work");
      expect((await push(src, [server.url, "work:master"])).code).toBe(0);
      expect(server.results[0].outcome).toBe("ok");
      // The hint does not name the push yet
      const hinted = await store.get(LATEST_KEY).then(
        (bytes) => JSON.parse(bytes).seq,
        () => null
      );
      expect(hinted).not.toBe(before.seq + 1);

      const seen = await manifest.read(other);
      expect(seen.seq).toBe(before.seq + 1);
      expect(seen.refs[MASTER]).toBe(tip);
      land();
    });

    it("accepts a push which carries no objects", async function () {
      const before = await manifest.read(store);
      const puts = store.stats.puts;

      const pushed = await push(src, [
        server.url,
        fixture.commits[1] + ":refs/tags/old",
      ]);
      expect(pushed.code).toBe(0);

      const current = await manifest.read(store);
      expect(current.seq).toBe(before.seq + 1);
      expect(current.refs["refs/tags/old"]).toBe(fixture.commits[1]);
      // The tag's commit is not known to be reachable (this repository was seeded
      // with no history pieces), so the packs are listed again
      expect(current.packs.map((pack) => pack.name)).toEqual(
        before.packs.map((pack) => pack.name)
      );
      expect(current.historyPieces).toEqual([]);
      expect(store.stats.puts - puts).toBe(1); // the hint, no packs
      expectNoScratch();
    });

    it("refuses a branch other than master, and changes nothing", async function () {
      const tip = commit("work");
      const before = await manifest.read(store);
      const puts = store.stats.puts;

      const pushed = await push(src, [server.url, tip + ":refs/heads/other"]);
      expect(pushed.code).not.toBe(0);
      expect(pushed.stderr).toContain("only the master branch is allowed");

      expect(server.results[0].outcome).toBe("refused");
      expect(await manifest.read(store)).toEqual(before);
      expect(store.stats.puts).toBe(puts);
      expectNoScratch();
    });

    it("refuses master and another branch pushed together, in either order", async function () {
      commit("work");
      const before = await manifest.read(store);

      for (const refs of [
        ["work:master", "work:other"],
        ["work:other", "work:master"],
      ]) {
        const pushed = await push(src, [server.url, ...refs]);
        expect(pushed.code).not.toBe(0);
        expect(pushed.stderr).toContain("only the master branch is allowed");
      }

      expect(await manifest.read(store)).toEqual(before);
    });

    it("refuses to delete master", async function () {
      const before = await manifest.read(store);
      const pushed = await push(src, [server.url, ":master"]);
      expect(pushed.code).not.toBe(0);
      expect(pushed.stderr).toContain("master cannot be deleted");
      expect(await manifest.read(store)).toEqual(before);
    });
  });

  describe("receive() with the pack in hand", function () {
    beforeEach(() => setup());
    afterEach(teardown);

    it("takes a first push to an empty repository: a root commit checks every entry", async function () {
      const empty = createMemoryStore();
      const everything = fx.packRevs(src, [fixture.head, fixture.tag], []);

      const result = await receive({
        store: empty,
        cache,
        lock,
        commands: [update(fixture.head, MASTER, ZERO)],
        pack: bodyOf(everything),
      });
      expect(result.outcome).toBe("ok");

      const current = await manifest.read(empty);
      expect(current.seq).toBe(1);
      expect(current.head).toBe(MASTER);
      expect(current.refs[MASTER]).toBe(fixture.head);
      expect(current.historyPieces[0].objects).toBe(fixture.commits.length);
      store = empty;
      await expectReadable(current, fixture.head);
      await expectFsck(current, fixture.head);
      expectNoScratch();
    });

    it("answers git's empty probe without touching the store or the cache", async function () {
      const before = JSON.stringify(store.stats);
      const result = await direct([], null);

      expect(result.outcome).toBe("ok");
      expect(result.results).toEqual([]);
      expect(JSON.stringify(store.stats)).toBe(before);
      expect(fs.existsSync(path.join(dir, "cache", "scratch"))).toBe(false);
      expect((await manifest.read(store)).seq).toBe(1);
    });

    // A raw object, written as given, which git's own commands would not make
    const forge = (type, body) =>
      fx
        .git(
          src,
          ["hash-object", "-t", type, "-w", "--stdin", "--literally"],
          body
        )
        .toString()
        .trim();
    const forgeCommit = (tree, parent) =>
      forge(
        "commit",
        "tree " +
          tree +
          "\n" +
          (parent ? "parent " + parent + "\n" : "") +
          "author A <a@example.com> 1 +0000\ncommitter A <a@example.com> 1 +0000\n\nForged\n"
      );
    const packOf = (...oids) =>
      fx.git(src, ["pack-objects", "--stdout", "-q"], oids.join("\n") + "\n");

    async function expectWrongType(tip, pack) {
      const before = await manifest.read(store);
      const keys = await packKeys();
      const result = await direct([update(tip)], pack);

      expect(result.outcome).toBe("refused");
      // git's own object check may stop it first; either way it is refused
      expect(result.results[0].error).toMatch(/wrong type|unpacker error/);
      await expectNothingNamed(before, keys);
      expectNoScratch();
    }

    it("refuses a commit whose tree is not a tree", async function () {
      const blob = forge("blob", "just a file\n");
      const tip = forgeCommit(blob, fixture.head);
      await expectWrongType(tip, packOf(tip, blob));
    });

    it("refuses a commit whose parent is not a commit", async function () {
      const tree = fx.text(src, ["rev-parse", fixture.head + "^{tree}"]);
      const tip = forgeCommit(tree, tree);
      await expectWrongType(tip, packOf(tip, tree));
    });

    it("refuses a directory entry which is a blob, and a file entry which is a tree", async function () {
      const blob = forge("blob", "just a file\n");
      const inner = forge(
        "tree",
        Buffer.concat([Buffer.from("100644 f\0"), Buffer.from(blob, "hex")])
      );

      for (const mode of ["40000", "100644"]) {
        const target = mode === "40000" ? blob : inner;
        const tree = forge(
          "tree",
          Buffer.concat([
            Buffer.from(mode + " x\0"),
            Buffer.from(target, "hex"),
          ])
        );
        const tip = forgeCommit(tree, fixture.head);
        await expectWrongType(
          tip,
          packOf(tip, tree, target, ...(target === inner ? [blob] : []))
        );
      }
    });

    it("refuses a commit whose tree, or parent, is a blob the repository already has", async function () {
      const stored = fx.text(src, [
        "rev-parse",
        fixture.head + ":docs/big.txt",
      ]);
      const tree = fx.text(src, ["rev-parse", fixture.head + "^{tree}"]);

      const withTree = forgeCommit(stored, fixture.head);
      await expectWrongType(withTree, packOf(withTree));
      const withParent = forgeCommit(tree, stored);
      await expectWrongType(withParent, packOf(withParent));
    });

    it("refuses a tree entry whose stored target is the wrong type", async function () {
      const stored = fx.text(src, [
        "rev-parse",
        fixture.head + ":docs/big.txt",
      ]);
      const dir = fx.text(src, ["rev-parse", fixture.head + ":docs"]);

      for (const [mode, target] of [
        ["40000", stored],
        ["100644", dir],
      ]) {
        const tree = forge(
          "tree",
          Buffer.concat([
            Buffer.from(mode + " x\0"),
            Buffer.from(target, "hex"),
          ])
        );
        const tip = forgeCommit(tree, fixture.head);
        await expectWrongType(tip, packOf(tip, tree));
      }
    });

    it("moves master to a stored commit of any size with no pack", async function () {
      const tree = fx.text(src, ["rev-parse", fixture.head + "^{tree}"]);
      const big = fx.text(
        src,
        ["commit-tree", tree, "-p", fixture.head],
        "x".repeat(1200 * 1024) + "\n"
      );
      expect(
        (
          await direct(
            [update(big, "refs/tags/big", ZERO)],
            fx.packRevs(src, [big], [fixture.head], { thin: true })
          )
        ).outcome
      ).toBe("ok");

      const result = await direct([update(big)], null);
      expect(result.outcome).toBe("ok");
      expect((await manifest.read(store)).refs[MASTER]).toBe(big);
    });

    it("takes a commit on top of a stored parent too large to read", async function () {
      const tree = fx.text(src, ["rev-parse", fixture.head + "^{tree}"]);
      const big = fx.text(
        src,
        ["commit-tree", tree, "-p", fixture.head],
        "x".repeat(65 * MiB) + "\n"
      );
      const roomy = {
        cache: createCache({
          dir: path.join(dir, "roomy"),
          maxBytes: 1024 * MiB,
        }),
      };
      expect(
        (
          await direct(
            [update(big)],
            fx.packRevs(src, [big], [fixture.head], { thin: true }),
            roomy
          )
        ).outcome
      ).toBe("ok");

      const child = fx.text(src, ["commit-tree", tree, "-p", big], "After\n");
      const result = await direct(
        [update(child, MASTER, big)],
        fx.packRevs(src, [child], [big], { thin: true }),
        roomy
      );

      expect(result.outcome).toBe("ok");
      expect((await manifest.read(store)).refs[MASTER]).toBe(child);
    });

    it("fails, and does not crash, when the scratch file cannot be written while the next chunk is awaited", async function () {
      // incoming.pack is a directory, so opening it for writing fails at once
      const broken = {
        ...cache,
        reserve: async (bytes) => {
          const reservation = await cache.reserve(bytes);
          fs.mkdirSync(path.join(reservation.dir, "incoming.pack"));
          return reservation;
        },
      };
      const tip = commit("work");
      const slow = (async function* () {
        await new Promise((resolve) => setTimeout(resolve, 200));
        yield thin(tip);
      })();

      const result = await receive({
        store,
        cache: broken,
        lock,
        commands: [update(tip)],
        pack: slow,
      });
      expect(result.outcome).toBe("failed");
      expect(result.messages).toContain("Nothing was pushed.");
      await new Promise((resolve) => setTimeout(resolve, 50));
      expectNoScratch();
    });

    describe("ref names which are a file and a directory", function () {
      const create = (ref, oid = fixture.commits[1]) => ({
        old: ZERO,
        new: oid,
        ref,
      });
      const conflict = (ref, other) =>
        new RegExp("cannot lock ref '" + ref + "': '" + other + "' exists");

      it("refuses a ref inside an existing one", async function () {
        const result = await direct([create("refs/tags/v1/x")], null);
        expect(result.outcome).toBe("refused");
        expect(result.results[0].error).toMatch(
          conflict("refs/tags/v1/x", "refs/tags/v1")
        );
      });

      it("refuses a ref which an existing one is inside", async function () {
        expect((await direct([create("refs/tags/a/b")], null)).outcome).toBe(
          "ok"
        );
        const result = await direct([create("refs/tags/a")], null);
        expect(result.outcome).toBe("refused");
        expect(result.results[0].error).toMatch(
          conflict("refs/tags/a", "refs/tags/a/b")
        );
      });

      it("refuses both in one push", async function () {
        const result = await direct(
          [create("refs/tags/p"), create("refs/tags/p/q")],
          null
        );
        expect(result.outcome).toBe("refused");
        expect(
          result.results.some((r) => /cannot lock ref/.test(r.error || ""))
        ).toBe(true);
        expect(
          (await manifest.read(store)).refs["refs/tags/p"]
        ).toBeUndefined();
      });

      it("allows deleting one and creating inside it in the same push", async function () {
        const result = await direct(
          [
            { old: fixture.tag, new: ZERO, ref: "refs/tags/v1" },
            create("refs/tags/v1/x"),
          ],
          null
        );
        expect(result.outcome).toBe("ok");
        const refs = (await manifest.read(store)).refs;
        expect(refs["refs/tags/v1"]).toBeUndefined();
        expect(refs["refs/tags/v1/x"]).toBe(fixture.commits[1]);
      });

      it("catches a conflict made by a push which lands while this one is arriving", async function () {
        // The other push landed after this one read the manifest it started from
        const tip = commit("work");
        const body = (async function* () {
          yield thin(tip);
          expect((await direct([create("refs/tags/z/y")], null)).outcome).toBe(
            "ok"
          );
        })();
        const result = await receive({
          store,
          cache,
          lock,
          commands: [update(tip), create("refs/tags/z", tip)],
          pack: body,
        });
        expect(result.outcome).toBe("refused");
        expect(
          result.results.some((r) =>
            /cannot lock ref 'refs\/tags\/z'/.test(r.error || "")
          )
        ).toBe(true);
        expect((await manifest.read(store)).refs[MASTER]).toBe(fixture.head);
        expectNoScratch();
      });
    });

    it("refuses a stale base: the ref has moved since the client looked", async function () {
      const a = commit("a");
      const b = commit("b");

      expect((await direct([update(a)], thin(a))).outcome).toBe("ok");
      const before = await manifest.read(store);
      const puts = store.stats.puts;

      const result = await direct([update(b)], thin(b));
      expect(result.outcome).toBe("refused");
      expect(result.results).toEqual([
        {
          ref: MASTER,
          error: "the ref moved while you were pushing; pull and try again",
        },
      ]);
      expect(result.messages).toContain("Nothing was pushed.");

      expect(await manifest.read(store)).toEqual(before);
      expect(store.stats.puts).toBe(puts);
      expectNoScratch();
    });

    describe("when another writer's manifest lands just before the push's", function () {
      const create = (ref, oid = fixture.commits[1]) => ({
        old: ZERO,
        new: oid,
        ref,
      });
      const MOVED_ERROR =
        "the ref moved while you were pushing; pull and try again";

      // A lock which, for the first `wins.length` swaps, lets `wins[n]()` land a
      // manifest after the push has built its own and before it creates it
      function racing(wins) {
        const state = { swaps: 0 };
        state.lock = async (fn) => {
          const win = wins[state.swaps++];
          if (win) await win();
          return lock(fn);
        };
        return state;
      }

      // What compaction does to the manifest: a new seq, the same refs and packs
      async function compaction() {
        const base = await manifest.read(store);
        await manifest.swap({
          store,
          lock,
          base,
          next: manifest.advance(base, { refs: base.refs }),
        });
      }

      const tagged = (ref, oid) => async () =>
        expect((await direct([create(ref, oid)], null)).outcome).toBe("ok");
      const blotCommit = (name) => async () =>
        expect(
          (
            await blotWrite({
              store,
              cache,
              lock,
              path: name,
              contents: Buffer.from("x\n"),
            })
          ).changed
        ).toBe(true);
      const pushed = (tip) => async () =>
        expect((await direct([update(tip)], thin(tip))).outcome).toBe("ok");

      it("applies the push on the new manifest when only the packs changed", async function () {
        const b = commit("b");
        const before = await manifest.read(store);
        const race = racing([compaction]);
        const puts = store.stats.puts;

        const result = await receive({
          store,
          cache,
          lock: race.lock,
          commands: [update(b)],
          pack: bodyOf(thin(b)),
        });
        expect(result.outcome).toBe("ok");
        expect(race.swaps).toBe(2);
        expect(result.seq).toBe(before.seq + 2);

        // The push's five uploads once (not again for the retry), and a hint for each manifest
        expect(store.stats.puts - puts).toBe(5 + 2);

        const current = await manifest.read(store);
        expect(current.seq).toBe(before.seq + 2);
        expect(current.refs).toEqual({
          [MASTER]: b,
          "refs/tags/v1": fixture.tag,
        });
        expect(current.packs.map((pack) => pack.name)).toEqual([
          ...before.packs.map((pack) => pack.name),
          result.stats.packs[0],
        ]);
        expect(current.historyPieces.length).toBe(1);
        await expectReadable(current, b);
        await expectFsck(current, b);
        expectNoScratch();
      });

      it("succeeds when Blot commits to master while a tag is pushed", async function () {
        const race = racing([blotCommit("race.txt")]);
        const result = await receive({
          store,
          cache,
          lock: race.lock,
          commands: [create("refs/tags/old")],
          pack: null,
        });
        expect(result.outcome).toBe("ok");
        expect(race.swaps).toBe(2);

        const current = await manifest.read(store);
        expect(current.refs["refs/tags/old"]).toBe(fixture.commits[1]);
        expect(current.refs[MASTER]).not.toBe(fixture.head);
        expect(current.seq).toBe(3);
        expectNoScratch();
      });

      it("succeeds when another push moves a different ref", async function () {
        const b = commit("b");
        const race = racing([tagged("refs/tags/other")]);
        const result = await receive({
          store,
          cache,
          lock: race.lock,
          commands: [update(b)],
          pack: bodyOf(thin(b)),
        });
        expect(result.outcome).toBe("ok");

        const current = await manifest.read(store);
        expect(current.refs[MASTER]).toBe(b);
        expect(current.refs["refs/tags/other"]).toBe(fixture.commits[1]);
        await expectReadable(current, b);
      });

      it("records a pushed tag's peeled target when it retries", async function () {
        fx.git(src, ["tag", "-a", "-m", "Release", "rel1", fixture.head]);
        const tag = fx.text(src, ["rev-parse", "refs/tags/rel1"]);

        const race = racing([blotCommit("race.txt")]);
        const result = await receive({
          store,
          cache,
          lock: race.lock,
          commands: [create("refs/tags/rel1", tag)],
          pack: bodyOf(fx.packRevs(src, [tag], [fixture.head], { thin: true })),
        });
        expect(result.outcome).toBe("ok");
        expect(race.swaps).toBe(2);

        const current = await manifest.read(store);
        expect(current.refs["refs/tags/rel1"]).toBe(tag);
        expect(current.peeled[tag]).toBe(fixture.head);
      });

      it("works out again which packs a tag push makes needed", async function () {
        // A tag on a commit no ref reaches lists every pack again, with the seq
        // of the manifest it lands on, which is the one after the race's
        const race = racing([compaction]);
        const before = await manifest.read(store);
        const result = await receive({
          store,
          cache,
          lock: race.lock,
          commands: [create("refs/tags/old")],
          pack: null,
        });
        expect(result.outcome).toBe("ok");

        const current = await manifest.read(store);
        expect(current.seq).toBe(before.seq + 2);
        expect(current.packs.map((pack) => [pack.name, pack.seq])).toEqual(
          before.packs.map((pack) => [pack.name, current.seq])
        );
      });

      it("refuses when another push moved the same ref, as before", async function () {
        const a = commit("a");
        const b = commit("b");
        const race = racing([pushed(a)]);

        const result = await receive({
          store,
          cache,
          lock: race.lock,
          commands: [update(b)],
          pack: bodyOf(thin(b)),
        });
        expect(result.outcome).toBe("refused");
        expect(race.swaps).toBe(1);
        expect(result.results).toEqual([{ ref: MASTER, error: MOVED_ERROR }]);
        expect(result.messages).toContain("Nothing was pushed.");

        const current = await manifest.read(store);
        expect(current.refs[MASTER]).toBe(a);
        expectNoScratch();
      });

      it("refuses only for the refs that moved", async function () {
        const a = commit("a");
        const b = commit("b");
        const race = racing([pushed(a)]);

        const result = await receive({
          store,
          cache,
          lock: race.lock,
          commands: [update(b), create("refs/tags/new")],
          pack: bodyOf(thin(b)),
        });
        expect(result.outcome).toBe("refused");
        expect(result.results.find((r) => r.ref === MASTER).error).toBe(
          MOVED_ERROR
        );
        expect(
          (await manifest.read(store)).refs["refs/tags/new"]
        ).toBeUndefined();
      });

      it("refuses when the other writer made a name conflict", async function () {
        const b = commit("b");
        const race = racing([tagged("refs/tags/z/y")]);
        const result = await receive({
          store,
          cache,
          lock: race.lock,
          commands: [update(b), create("refs/tags/z")],
          pack: bodyOf(thin(b)),
        });
        expect(result.outcome).toBe("refused");
        expect(
          result.results.some((r) =>
            /cannot lock ref 'refs\/tags\/z'/.test(r.error || "")
          )
        ).toBe(true);
        expect((await manifest.read(store)).refs[MASTER]).toBe(fixture.head);
      });

      it("retries more than once, but not past three attempts in all", async function () {
        const b = commit("b");
        const twice = racing([compaction, compaction]);
        const ok = await receive({
          store,
          cache,
          lock: twice.lock,
          commands: [update(b)],
          pack: bodyOf(thin(b)),
        });
        expect(ok.outcome).toBe("ok");
        expect(twice.swaps).toBe(3);
        expect((await manifest.read(store)).refs[MASTER]).toBe(b);

        const c = commit("c");
        const before = await manifest.read(store);
        const thrice = racing([compaction, compaction, compaction]);
        const result = await receive({
          store,
          cache,
          lock: thrice.lock,
          commands: [update(c, MASTER, b)],
          pack: bodyOf(fx.packRevs(src, [c], [b], { thin: true })),
        });
        expect(thrice.swaps).toBe(3);
        expect(result.outcome).toBe("refused");
        expect(result.results).toEqual([{ ref: MASTER, error: MOVED_ERROR }]);

        const current = await manifest.read(store);
        expect(current.seq).toBe(before.seq + 3);
        expect(current.refs[MASTER]).toBe(b);
        expectNoScratch();
      });
    });

    it("refuses a tip which is not there, even when no objects came with it", async function () {
      const before = await manifest.read(store);
      const puts = store.stats.puts;

      const result = await direct([update("1".repeat(40))], null);
      expect(result.outcome).toBe("refused");
      expect(result.results[0].error).toBe("missing necessary objects");

      expect(await manifest.read(store)).toEqual(before);
      expect(store.stats.puts).toBe(puts);
      expectNoScratch();
    });

    it("refuses a branch which points at something other than a commit", async function () {
      const result = await direct(
        [update(fx.text(src, ["rev-parse", fixture.head + "^{tree}"]))],
        null
      );
      expect(result.outcome).toBe("refused");
      expect(result.results[0].error).toBe("branches must point to a commit");
    });

    it("refuses a commit whose tree points at an object nobody has", async function () {
      const lie = fx
        .git(
          src,
          ["mktree", "--missing"],
          "100644 blob " + "ab".repeat(20) + "\tghost.txt\n"
        )
        .toString()
        .trim();
      const tip = fx.text(src, [
        "commit-tree",
        lie,
        "-p",
        fixture.head,
        "-m",
        "Points at a ghost",
      ]);
      const pack = fx.git(
        src,
        ["pack-objects", "--stdout", "-q"],
        tip + "\n" + lie + "\n"
      );

      const before = await manifest.read(store);
      const keys = await packKeys();

      const result = await direct([update(tip)], pack);
      expect(result.outcome).toBe("refused");
      expect(result.results[0].error).toBe("missing necessary objects");
      await expectNothingNamed(before, keys);
      expectNoScratch();
    });

    it("refuses a thin pack whose base the repository does not have", async function () {
      // "other" is built on "work", which was never pushed, so its deltas name blobs the store lacks
      const work = commit("work");
      fx.git(src, ["checkout", "-q", "-B", "other", work]);
      fs.writeFileSync(
        path.join(src, "docs", "big.txt"),
        fs
          .readFileSync(path.join(src, "docs", "big.txt"), "utf8")
          .replace("line 5 ", "line 5 else ")
      );
      fx.git(src, ["commit", "-q", "-am", "On top of work"]);
      const other = fx.text(src, ["rev-parse", "HEAD"]);

      const result = await direct(
        [update(other)],
        fx.packRevs(src, [other], [work], { thin: true })
      );
      expect(result.outcome).toBe("refused");
      expect(result.status).not.toBe("ok");
      expect(result.messages[0]).toMatch(/^Push failed: /);
      expectNoScratch();
    });

    it("refuses bytes which are not a pack", async function () {
      const result = await direct(
        [update(fixture.head)],
        Buffer.from("PACK this is not a pack, not at all, no")
      );
      expect(result.outcome).toBe("refused");
      expect(result.status).toMatch(/not valid/);
      expectNoScratch();
    });

    describe("with regularFilesOnly", function () {
      const symlink = (name) => () =>
        fs.symlinkSync("docs/big.txt", path.join(src, name));

      it("refuses a master which adds a symbolic link, with Blot's message, and changes nothing", async function () {
        const tip = commit("link", symlink("link"));
        const before = await manifest.read(store);

        const result = await direct([update(tip)], thin(tip), {
          regularFilesOnly: true,
        });
        expect(result.outcome).toBe("refused");
        expect(result.results).toEqual([
          {
            ref: MASTER,
            error:
              "Git blogs support regular files only (no symbolic links or submodules)",
          },
        ]);
        expect((await manifest.read(store)).seq).toBe(before.seq);
        expectNoScratch();
      });

      it("looks into the directories a push changes", async function () {
        const tip = commit("nested", () => {
          fs.mkdirSync(path.join(src, "deep", "er"), { recursive: true });
          fs.symlinkSync(
            "../../docs/big.txt",
            path.join(src, "deep", "er", "link")
          );
        });

        const result = await direct([update(tip)], thin(tip), {
          regularFilesOnly: true,
        });
        expect(result.outcome).toBe("refused");
        expect(result.results[0].error).toMatch(/regular files only/);
      });

      it("refuses a submodule", async function () {
        // By plumbing: `git add -A` would drop a gitlink with no repository there
        fx.git(src, ["checkout", "-q", "-B", "submodule", fixture.head]);
        fx.git(src, [
          "update-index",
          "--add",
          "--cacheinfo",
          "160000," + fixture.commits[0] + ",vendor",
        ]);
        fx.git(src, ["commit", "-q", "-m", "A submodule"]);
        const tip = fx.text(src, ["rev-parse", "HEAD"]);

        const result = await direct([update(tip)], thin(tip), {
          regularFilesOnly: true,
        });
        expect(result.outcome).toBe("refused");
        expect(result.results[0].error).toMatch(/regular files only/);
      });

      it("takes regular files, an executable and a tag pointing anywhere", async function () {
        const tip = commit("plain", () => {
          fs.writeFileSync(path.join(src, "run.sh"), "#!/bin/sh\n");
          fs.chmodSync(path.join(src, "run.sh"), 0o755);
        });

        const result = await direct([update(tip)], thin(tip), {
          regularFilesOnly: true,
        });
        expect(result.outcome).toBe("ok");

        // A tag is not master: what it points at is not checked
        const linked = commit("tagged-link", symlink("link"));
        const tagged = await direct(
          [{ old: ZERO, new: linked, ref: "refs/tags/linked" }],
          fx.packRevs(src, [linked], [tip], { thin: true }),
          { regularFilesOnly: true }
        );
        expect(tagged.outcome).toBe("ok");
      });

      it("is off unless asked for", async function () {
        const tip = commit("link", symlink("link"));
        expect((await direct([update(tip)], thin(tip))).outcome).toBe("ok");
      });
    });

    it("refuses a push over the limit, after reading it all", async function () {
      const tip = commit("big", () =>
        fs.writeFileSync(path.join(src, "big.bin"), fx.bytes(9, 2 * MiB))
      );
      const pack = thin(tip);
      expect(pack.length).toBeGreaterThan(MiB);

      const result = await direct([update(tip)], pack, { limit: MiB });
      expect(result.outcome).toBe("refused");
      expect(result.status).toBe(
        "this push is larger than Blot accepts (1 MiB); push fewer or smaller files at a time"
      );

      const early = await direct([update(tip)], pack, {
        limit: MiB,
        sizeHint: pack.length,
      });
      expect(early.status).toBe(result.status);
      expectNoScratch();
    });

    it("fails clearly when the cache has no room, and gives the budget back", async function () {
      const small = createCache({
        dir: path.join(dir, "small"),
        maxBytes: 256 * 1024,
      });
      const tip = commit("big", () =>
        fs.writeFileSync(path.join(src, "big.bin"), fx.bytes(9, 2 * MiB))
      );

      const result = await receive({
        store,
        cache: small,
        lock,
        commands: [update(tip)],
        pack: bodyOf(thin(tip)),
      });
      expect(result.outcome).toBe("failed");
      expect(result.status).toMatch(/no room/);
      expect(result.error.code).toBe("NO_ROOM");
      expect(result.messages).toContain("Nothing was pushed.");

      expect(small.stats().reservedBytes).toBe(0);
      expect(fs.readdirSync(path.join(dir, "small", "scratch"))).toEqual([]);
      expect((await manifest.read(store)).refs[MASTER]).toBe(fixture.head);
    });
  });

  describe("a base bigger than the default cap", function () {
    beforeEach(() =>
      setup({
        maxBytes: 1024 * MiB,
        prepare: (dir) => {
          // 70 MiB which compresses to almost nothing, so the spec costs no disk
          fs.writeFileSync(path.join(dir, "huge.txt"), hugeFile(0));
          fx.git(dir, ["add", "-A"]);
          fx.git(dir, ["commit", "-q", "-m", "Add a huge file"]);
        },
      })
    );
    afterEach(teardown);

    function hugeFile(edit) {
      const line = Buffer.from(
        "this line of the huge file is the same on every row of it......\n"
      );
      const data = Buffer.alloc(70 * MiB);
      for (let at = 0; at < data.length; at += line.length)
        line.copy(data, at, 0, Math.min(line.length, data.length - at));
      if (edit) data.write("EDITED " + edit, 35 * MiB);
      return data;
    }

    it("streams it to scratch, and the push is accepted", async function () {
      expect(
        Number(fx.text(src, ["cat-file", "-s", fixture.head + ":huge.txt"]))
      ).toBeGreaterThan(64 * MiB);

      const tip = commit("work", () =>
        fs.writeFileSync(path.join(src, "huge.txt"), hugeFile(1))
      );
      const pack = thin(tip);
      expect(pack.length).toBeLessThan(MiB);

      const result = await direct([update(tip)], pack);
      expect(result.outcome).toBe("ok");
      expect(result.stats.basesFetched).toBeGreaterThan(0);
      expect((await manifest.read(store)).refs[MASTER]).toBe(tip);
      expectNoScratch();
    });
  });

  describe("a base stored as a delta", function () {
    // `smallBase` is lowered so that a base of a few MiB is built in scratch
    // as one of any size is; nothing depends on how big it is
    const SIZE = 3 * MiB;
    const SMALL = 256 * 1024;

    function hugeFile(edit) {
      const line = Buffer.from(
        "this line of the huge file is the same on every row of it......\n"
      );
      const data = Buffer.alloc(SIZE);
      for (let at = 0; at < data.length; at += line.length)
        line.copy(data, at, 0, Math.min(line.length, data.length - at));
      if (edit) data.write("EDITED " + edit, MiB);
      return data;
    }

    // A push on the first version of a file the store holds two versions of,
    // so that its base is stored as a delta of the second
    function pushOnOldVersion() {
      const [stored] = fx.readPacks(src);
      const entries = fx.listEntries(stored);
      const old = fx.text(src, ["rev-parse", "HEAD~1"]);
      const oid = fx.text(src, ["rev-parse", old + ":huge.txt"]);
      expect(entries.find((entry) => entry.oid === oid).depth).toBeGreaterThan(
        0
      );

      fx.git(src, ["checkout", "-q", "-B", "x", old]);
      fs.writeFileSync(
        path.join(src, "huge.txt"),
        hugeFile(0).fill("E", 2 * MiB, 2 * MiB + 100)
      );
      fx.git(src, ["commit", "-q", "-am", "On an old version"]);
      const tip = fx.text(src, ["rev-parse", "HEAD"]);
      return { tip, pack: fx.packRevs(src, [tip], [old], { thin: true }) };
    }

    function prepare(target) {
      for (const edit of [0, 1]) {
        fs.writeFileSync(path.join(target, "huge.txt"), hugeFile(edit));
        fx.git(target, ["add", "-A"]);
        fx.git(target, ["commit", "-q", "-m", "Huge " + edit]);
      }
    }

    afterEach(teardown);

    it("is read through scratch, and counted against the push's reservation", async function () {
      await setup({ maxBytes: 64 * MiB, prepare });
      const { tip, pack } = pushOnOldVersion();
      expect(pack.length).toBeLessThan(MiB);

      const reserved = [];
      const timer = setInterval(
        () => reserved.push(cache.stats().reservedBytes),
        1
      );
      const result = await direct([update(tip)], pack, { smallBase: SMALL });
      clearInterval(timer);

      expect(result.outcome).toBe("ok");
      expect(result.stats.basesFetched).toBeGreaterThan(0);
      expect((await manifest.read(store)).refs[MASTER]).toBe(tip);

      // The files built to resolve it (two at once) and the copies of it
      // index-pack makes are in the reservation together
      expect(Math.max(...reserved)).toBeGreaterThan(3 * SIZE);
      expectNoScratch();
    });

    it("fails the push, to be tried again, when the room is taken just now", async function () {
      await setup({ maxBytes: 64 * MiB, prepare });
      const { tip, pack } = pushOnOldVersion();
      const hold = await cache.reserve(58 * MiB);

      const failed = await direct([update(tip)], pack, { smallBase: SMALL });

      expect(failed.outcome).toBe("failed");
      expect(failed.error.code).toBe("NO_ROOM");
      expect(failed.messages).toContain("Nothing was pushed.");
      expect((await manifest.read(store)).refs[MASTER]).toBe(fixture.head);

      await hold.release();
      expectNoScratch();
      expect(
        (await direct([update(tip)], pack, { smallBase: SMALL })).outcome
      ).toBe("ok");
    });

    it("refuses the push, for good, when the whole budget could never hold it", async function () {
      await setup({ maxBytes: 5 * MiB, prepare });
      const { tip, pack } = pushOnOldVersion();

      const refused = await direct([update(tip)], pack, { smallBase: SMALL });

      expect(refused.outcome).toBe("refused");
      expect(refused.status).toMatch(
        /builds on a file of 3 MiB which is larger than Blot can currently handle. Please contact support/
      );
      expect((await manifest.read(store)).refs[MASTER]).toBe(fixture.head);
      expectNoScratch();
    });
  });

  describe("when the object store misbehaves", function () {
    let faulty;

    beforeEach(async function () {
      faulty = null;
      await setup({ wrap: (s) => (faulty = faults(s)) });
    });
    afterEach(teardown);

    it("leaves the refs and manifest alone when a pack will not upload", async function () {
      const tip = commit("work");
      const before = await manifest.read(store);
      faulty.inject("put", { key: /\.pack$/, before: dropped() });

      const result = await direct([update(tip)], thin(tip));
      expect(result.outcome).toBe("failed");
      expect(result.error.code).toBe("ECONNRESET");
      expect(result.messages).toContain("Nothing was pushed.");

      expect(await manifest.read(store)).toEqual(before);
      expect(await store.head(manifestKey(before.seq + 1))).toBeNull();
      expectNoScratch();
    });

    it("leaves them alone when the index will not upload either", async function () {
      const tip = commit("work");
      const before = await manifest.read(store);
      faulty.inject("put", { key: /\.idx$/, before: dropped() });

      expect((await direct([update(tip)], thin(tip))).outcome).toBe("failed");
      expect(await manifest.read(store)).toEqual(before);
      expectNoScratch();
    });

    it("reports a swap whose outcome cannot be known as neither success nor failure", async function () {
      const tip = commit("work");
      const next = manifestKey(2);

      // The manifest lands, the answer is lost, and so is the read back
      faulty.inject("putIfAbsent", { key: next, after: dropped() });
      faulty.inject("get", { key: next, before: dropped(), times: 5 });

      const result = await direct([update(tip)], thin(tip));
      expect(result.outcome).toBe("unknown");
      expect(result.status).not.toBe("ok");
      expect(result.results.every((r) => r.error)).toBe(true);
      expect(result.messages.join(" ")).toMatch(/could not confirm/);
      expect(result.messages).not.toContain("Nothing was pushed.");
      expect(result.error.code).toBe("OUTCOME_UNKNOWN");

      // It did land, which is why the client must not be told it failed
      expect(await store.head(next)).not.toBeNull();
      expectNoScratch();
    });

    it("counts a swap whose answer was lost but which reads back as its own as a success", async function () {
      const tip = commit("work");
      faulty.inject("putIfAbsent", { key: manifestKey(2), after: dropped() });

      const result = await direct([update(tip)], thin(tip));
      expect(result.outcome).toBe("ok");
      expect((await manifest.read(store)).refs[MASTER]).toBe(tip);
    });

    // The pack's upload starts once index-pack has written it, before the
    // check of the new commits, so a check that fails finds it running
    it("aborts an upload still running when a check refuses the push, and names nothing", async function () {
      const lie = fx
        .git(
          src,
          ["mktree", "--missing"],
          "100644 blob " + "ab".repeat(20) + "\tghost.txt\n"
        )
        .toString()
        .trim();
      const tip = fx.text(src, [
        "commit-tree",
        lie,
        "-p",
        fixture.head,
        "-m",
        "Points at a ghost",
      ]);
      const pack = fx.git(
        src,
        ["pack-objects", "--stdout", "-q"],
        tip + "\n" + lie + "\n"
      );

      const before = await manifest.read(store);
      const keys = await packKeys();
      const calls = faulty.calls.length;
      // Every .pack upload (the push's, and its history piece's) is slow
      // enough that the check is done before either has sent its bytes
      faulty.inject("put", { key: /\.pack$/, delay: 300, times: 2 });

      const result = await direct([update(tip)], pack);
      expect(result.outcome).toBe("refused");
      expect(result.results[0].error).toBe("missing necessary objects");
      expect(
        faulty.calls.slice(calls).filter((call) => /^put .*\.pack$/.test(call))
          .length
      ).toBe(2);
      // Both slow uploads had ended, refused, before receive answered: the
      // history piece's body is a Buffer and lands, the pushed pack's is a
      // stream from scratch and was destroyed
      expect(faulty.pending()).toBe(0);

      const written = await expectNothingNamed(before, keys);
      // The pushed pack never landed; the one .pack that did is the piece
      const landed = written.filter((key) => key.endsWith(".pack"));
      expect(landed.length).toBe(1);
      const piece = fx.listEntries({
        pack: await store.get(landed[0]),
        idx: await store.get(landed[0].replace(/\.pack$/, ".idx")),
      });
      expect(piece.map((entry) => [entry.oid, entry.type])).toEqual([
        [tip, "commit"],
      ]);
      expectNoScratch();
    });

    it("leaves the manifest alone when an early upload fails while the checks pass", async function () {
      const tip = commit("work");
      const before = await manifest.read(store);
      faulty.inject("put", { key: /\.rev$/, delay: 50, before: dropped() });

      const result = await direct([update(tip)], thin(tip));
      expect(result.outcome).toBe("failed");
      expect(result.error.code).toBe("ECONNRESET");
      expect(await manifest.read(store)).toEqual(before);
      expect(await store.head(manifestKey(before.seq + 1))).toBeNull();
      expectNoScratch();
    });
  });

  // What a one-file push waits on, with 25 ms added to every request
  describe("the round trips of a push", function () {
    const LATENCY = 25;
    let timeline;

    function slow(inner) {
      const wrapped = { ...inner };
      const t = () => performance.now();
      for (const op of [
        "head",
        "read",
        "get",
        "put",
        "putIfAbsent",
        "delete",
      ]) {
        wrapped[op] = async (key, ...args) => {
          const entry = { op, key, start: t() };
          timeline.push(entry);
          try {
            await new Promise((resolve) => setTimeout(resolve, LATENCY));
            return await inner[op](key, ...args);
          } finally {
            entry.end = t();
          }
        };
      }
      return wrapped;
    }

    beforeEach(async function () {
      timeline = [];
      await setup({ wrap: slow });
    });
    afterEach(teardown);

    const said = (message) => (entry) =>
      entry.op === "say" && entry.key === message;
    const push = (tip) =>
      receive({
        store,
        cache,
        lock,
        commands: [update(tip)],
        pack: bodyOf(thin(tip)),
        progress: (message) =>
          timeline.push({ op: "say", key: message, start: performance.now() }),
      });

    for (const warm of [false, true]) {
      it(
        "uploads the pack beside the checks, and creates the manifest only once every upload has landed (" +
          (warm ? "warm" : "cold") +
          ")",
        async function () {
          if (warm) {
            const first = commit("first");
            expect((await push(first)).outcome).toBe("ok");
            fixture.head = first;
          }
          timeline.length = 0;

          const tip = commit("work");
          const result = await push(tip);
          expect(result.outcome).toBe("ok");

          const pushed = result.stats.packs[0];
          const upload = timeline.find(
            (entry) => entry.op === "put" && entry.key === packKey(pushed)
          );
          const checking = timeline.find(said("Checking the new commits..."));
          const saving = timeline.find(said("Saving to Blot..."));
          const create = timeline.find((entry) => entry.op === "putIfAbsent");

          // Started before the commits were checked, not after
          expect(upload.start).toBeLessThan(checking.start);
          expect(upload.start).toBeLessThan(saving.start);

          // Every upload had landed before the create was sent
          const uploads = timeline.filter(
            (entry) => entry.op === "put" && entry.key.startsWith("packs/")
          );
          expect(uploads.length).toBe(5);
          for (const entry of uploads)
            expect(entry.end).toBeLessThanOrEqual(create.start);

          // A warm push makes the same requests as before: the hint and a HEAD,
          // the five uploads, the create and the hint
          if (warm)
            expect(timeline.filter((entry) => entry.op !== "say").length).toBe(
              9
            );
        }
      );
    }
  });
});
