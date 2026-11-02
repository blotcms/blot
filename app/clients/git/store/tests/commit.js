// Blot's own commits, against real repositories. The repository in the store
// starts as a small one made with git; each write is made in the store and, to
// check it, the same write is made with git's plumbing, the way plumbing.js
// does it on disk (hash-object, a temporary index, write-tree, commit-tree).
// With the same times the two must make the same commit, byte for byte. The
// result is also exported to a bare repository for `git fsck --strict`.
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const { Readable } = require("stream");
const fx = require("./helpers/fixture");
const faults = require("./helpers/faults");
const timeout = require("./helpers/timeout");
const manifest = require("../manifest");
const commit = require("../commit");
const receive = require("../receive");
const createCache = require("../cache");
const createMemoryStore = require("../objectStore/memory");
const createReader = require("../reader");
const { manifestKey, packKey, idxKey, revKey } = require("../layout");
const { OutcomeUnknownError, TooLargeError, NoRoomError } = require("../errors");

const MASTER = "refs/heads/master";
const MiB = 1024 * 1024;
const T0 = Date.UTC(2026, 10, 2, 12, 0, 0);

const dropped = () => Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });

function createLock() {
  let tail = Promise.resolve();
  return (fn) => {
    const run = tail.then(fn);
    tail = run.catch(() => {});
    return run;
  };
}

// What plumbing.js does for one write, on a bare repository: `file` is the
// path in the tree, `contents` null to remove. Resolves with the commit, or
// null if there is nothing to commit.
function plumbing(bare, file, contents, ms) {
  const date = Math.floor(ms / 1000) + " +0000";
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_DIR: bare,
    GIT_AUTHOR_NAME: "Your Name",
    GIT_AUTHOR_EMAIL: "you@example.com",
    GIT_COMMITTER_NAME: "Your Name",
    GIT_COMMITTER_EMAIL: "you@example.com",
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_DATE: date,
    GIT_INDEX_FILE: path.join(bare, "temporary-index"),
    GIT_LITERAL_PATHSPECS: "1",
  };
  const git = (args, input) => {
    const result = spawnSync("git", args, { env, input, cwd: bare });
    if (result.status !== 0) throw new Error("git " + args.join(" ") + ": " + result.stderr);
    return result.stdout.toString();
  };

  try {
    const parent = spawnSync("git", ["rev-parse", "--verify", "--quiet", MASTER + "^{commit}"], { env, cwd: bare }).stdout.toString().trim() || null;
    let oid = null;
    if (contents !== null) oid = git(["hash-object", "-w", "--no-filters", "--stdin"], contents).trim();
    if (parent) git(["read-tree", parent]);

    const staged = git(["ls-files", "--stage", "-z", "--", file, file + "/"])
      .split("\0")
      .filter(Boolean)
      .map((line) => ({ mode: line.split(" ")[0], path: line.slice(line.indexOf("\t") + 1) }));

    let lines;
    if (contents === null) {
      lines = staged.map((entry) => "0 " + "0".repeat(40) + "\t" + entry.path + "\0");
    } else {
      const existing = staged.find((entry) => entry.path === file);
      lines = [(existing && existing.mode === "100755" ? "100755" : "100644") + " " + oid + "\t" + file + "\0"];
    }
    if (!lines.length) return null;

    git(["update-index", "-z", "--add", "--replace", "--index-info"], lines.join(""));
    const tree = git(["write-tree"]).trim();
    const before = parent ? git(["rev-parse", parent + "^{tree}"]).trim() : null;
    if (tree === before) return null;

    const args = ["commit-tree", tree, "-m", (contents === null ? "Removed " : "Updated ") + file];
    if (parent) args.push("-p", parent);
    const made = git(args).trim();
    git(["update-ref", MASTER, made, parent || "0".repeat(40)]);
    return made;
  } finally {
    fs.rmSync(env.GIT_INDEX_FILE, { force: true });
  }
}

describe("git store commit", function () {
  timeout(60 * 1000);

  const warm = !!zlib.crc32;

  let dir;
  let src;
  let inner;
  let store;
  let cache;
  let lock;
  let head;

  // A repository of a few files made with git, including an executable one
  function buildSource() {
    src = path.join(dir, "src");
    fs.mkdirSync(path.join(src, "posts", "2024"), { recursive: true });
    fs.mkdirSync(path.join(src, "docs"));
    fx.git(src, ["init", "-q", "-b", "master"]);
    fs.writeFileSync(path.join(src, "run.sh"), "#!/bin/sh\n");
    fs.chmodSync(path.join(src, "run.sh"), 0o755);
    fs.writeFileSync(path.join(src, "posts", "a.txt"), "A\n");
    fs.writeFileSync(path.join(src, "posts", "2024", "b.txt"), "B\n");
    fs.writeFileSync(path.join(src, "docs", "x.txt"), "X\n");
    fx.git(src, ["add", "-A"]);
    fx.git(src, ["commit", "-q", "-m", "Seed"]);
    return fx.text(src, ["rev-parse", "HEAD"]);
  }

  // The repository in the store as a push would have left it
  async function seed(target, tip) {
    fx.repackAll(src);
    const [pack] = fx.readPacks(src);
    const entry = await fx.upload(target, pack, fx.listEntries(pack).length);
    const base = manifest.empty();
    const next = manifest.advance(base, { refs: { [MASTER]: tip }, head: MASTER, packs: [entry] });
    await manifest.swap({ store: target, lock, base, next });
  }

  async function setup({ seeded = true, maxBytes = 64 * MiB } = {}) {
    dir = fx.tempDir();
    inner = createMemoryStore();
    store = faults(inner);
    cache = createCache({ dir: path.join(dir, "cache"), maxBytes });
    lock = createLock();
    head = null;
    if (seeded) {
      head = buildSource();
      await seed(store, head);
    }
  }

  const teardown = () => fx.remove(dir);

  // The repository as the store holds it, as a bare repository on disk
  async function exportRepo(name = "check.git") {
    const current = await manifest.read(store);
    const bare = path.join(dir, name);
    fx.remove(bare);
    fx.git(dir, ["init", "-q", "--bare", bare]);
    for (const pack of current.packs) {
      const target = path.join(bare, "objects", "pack", pack.name);
      fs.writeFileSync(target + ".pack", await store.get(packKey(pack.name)));
      fs.writeFileSync(target + ".idx", await store.get(idxKey(pack.name)));
    }
    fx.git(bare, ["update-ref", MASTER, current.refs[MASTER]]);
    return bare;
  }

  // git is satisfied with everything the store holds, and each pack Blot wrote
  // has the index git would write for it
  async function expectGitHappy() {
    const bare = await exportRepo();
    fx.git(bare, ["fsck", "--strict", "--no-dangling"]);

    const current = await manifest.read(store);
    for (const pack of current.packs) {
      const out = path.join(dir, "reindexed.idx");
      fx.git(bare, ["index-pack", "-o", out, path.join(bare, "objects", "pack", pack.name + ".pack")]);
      if (pack.seq > 1) {
        expect((await store.get(idxKey(pack.name))).equals(fs.readFileSync(out))).toBe(true, pack.name + ".idx");
      }
    }
    return bare;
  }

  const listing = (bare) => fx.text(bare, ["ls-tree", "-r", MASTER]);

  const used = (before) => Object.fromEntries(Object.keys(before).map((key) => [key, inner.stats[key] - before[key]]));

  describe("on a repository git made", function () {
    beforeEach(() => setup());
    afterEach(teardown);

    it("makes the commits plumbing.js makes: the same trees, messages, identity and modes", async function () {
      const oracle = path.join(dir, "oracle.git");
      fx.git(dir, ["clone", "-q", "--bare", src, oracle]);

      const steps = [
        ["posts/new.txt", "Hello"],
        ["posts/2024/deep/er/file.txt", "Deep"],
        ["run.sh", "#!/bin/sh\necho changed\n"],
        ["other.sh", "#!/bin/sh\n"],
        ["posts.txt", "sorts before the posts folder"],
        ["posts-x.txt", "and so does this"],
        ["Café/ünï côdé.md", "Unicode"],
        ["日本語/ファイル.txt", "日本語"],
        ["emoji 🎉/[draft] one.txt", "Brackets"],
        ["-leading-dash.txt", "Dash"],
        ["docs/x.txt", null],
        ["posts/2024", null],
        ["posts", "a file now, in the place of a folder"],
        ["run.sh/inner.txt", "a folder now, in the place of an executable file"],
        ["not/there.txt", null],
        ["nothing.txt", null],
        ["Café", null],
      ];

      for (const [i, [file, contents]] of steps.entries()) {
        const when = T0 + i * 1000;
        const result = await commit({
          store,
          cache,
          lock,
          path: "/" + file,
          contents: contents === null ? undefined : Buffer.from(contents),
          remove: contents === null,
          now: when,
        });
        const expected = plumbing(oracle, file, contents === null ? null : Buffer.from(contents), when);

        expect(result.outcome).toBe("ok");
        expect(result.commit).toBe(expected, file);
        expect(result.changed).toBe(expected !== null);
      }

      const bare = await expectGitHappy();
      expect(listing(bare)).toBe(listing(oracle));
      expect(fx.text(bare, ["log", "--format=%H|%an <%ae>|%cn <%ce>|%s", MASTER])).toBe(fx.text(oracle, ["log", "--format=%H|%an <%ae>|%cn <%ce>|%s", MASTER]));
      expect(fx.text(bare, ["log", "-1", "--format=%an <%ae>|%s", MASTER])).toBe("Your Name <you@example.com>|Removed Café");
    });

    it("keeps the mode of an executable file when it is written again", async function () {
      await commit({ store, cache, lock, path: "/run.sh", contents: Buffer.from("changed\n") });
      await commit({ store, cache, lock, path: "/other.sh", contents: Buffer.from("new\n") });

      const bare = await exportRepo();
      const tree = fx.text(bare, ["ls-tree", MASTER, "run.sh", "other.sh"]);
      expect(tree).toMatch(/^100755 blob [0-9a-f]+\trun\.sh$/m);
      expect(tree).toMatch(/^100644 blob [0-9a-f]+\tother\.sh$/m);
    });

    it("removes a file, a folder and everything in it, and a folder emptied of its last file", async function () {
      await commit({ store, cache, lock, path: "/folder/one.txt", contents: Buffer.from("1") });
      await commit({ store, cache, lock, path: "/folder/sub/two.txt", contents: Buffer.from("2") });
      await commit({ store, cache, lock, path: "/folder.txt", contents: Buffer.from("not in the folder") });

      await commit({ store, cache, lock, path: "/folder", remove: true });
      expect(listing(await exportRepo()).split("\n").map((l) => l.split("\t")[1])).toEqual(["docs/x.txt", "folder.txt", "posts/2024/b.txt", "posts/a.txt", "run.sh"]);

      await commit({ store, cache, lock, path: "/docs/x.txt", remove: true });
      expect(fx.text(await exportRepo(), ["ls-tree", MASTER, "docs"])).toBe("");
      await expectGitHappy();
    });

    it("makes no commit and writes nothing when the file already has the contents", async function () {
      const before = (await manifest.read(store)).seq;
      const writes = { ...inner.stats };

      const result = await commit({ store, cache, lock, path: "/posts/a.txt", contents: Buffer.from("A\n") });
      expect(result).toEqual(jasmine.objectContaining({ outcome: "ok", commit: null, parent: head, changed: false }));

      const none = await commit({ store, cache, lock, path: "/posts/not-there.txt", remove: true });
      expect(none.changed).toBe(false);
      const deeper = await commit({ store, cache, lock, path: "/nowhere/at/all.txt", remove: true });
      expect(deeper.changed).toBe(false);

      const spent = used(writes);
      expect(spent.puts).toBe(0);
      expect(spent.putIfAbsents).toBe(0);
      expect((await manifest.read(store)).seq).toBe(before);
    });

    it("makes no commit when removing from an empty repository", async function () {
      await setup({ seeded: false });
      const result = await commit({ store, cache, lock, path: "/a.txt", remove: true });
      expect(result.changed).toBe(false);
      expect(inner.stats.puts).toBe(0);
      expect(inner.stats.putIfAbsents).toBe(0);
    });

    it("refuses a path with .git, .. or an empty name in it, and writes nothing", async function () {
      const writes = { ...inner.stats };

      for (const bad of ["/.git/config", "/a/.GIT/b", "/a/../b", "/a/./b", "/", "", "/a\0b"]) {
        const error = await commit({ store, cache, lock, path: bad, contents: Buffer.from("x") }).then(() => null, (err) => err);
        expect(error).toEqual(jasmine.any(Error), JSON.stringify(bad));
        expect(error.code).toBe("EPATH");
      }

      const error = await commit({ store, cache, lock, path: "/.Git", remove: true }).then(() => null, (err) => err);
      expect(error.code).toBe("EPATH");
      expect(used(writes)).toEqual(jasmine.objectContaining({ puts: 0, putIfAbsents: 0, heads: 0, gets: 0, reads: 0 }));
    });

    it("writes a path in unicode normal form C", async function () {
      // "e" and a combining accent, as some clients send it
      const result = await commit({ store, cache, lock, path: "/café.txt", contents: Buffer.from("Café") });
      expect(result.changed).toBe(true);

      const bare = await exportRepo();
      expect(fx.git(bare, ["ls-tree", "--name-only", "-z", MASTER]).toString().split("\0")).toContain("café.txt");
      expect(fx.text(bare, ["log", "-1", "--format=%s", MASTER])).toBe("Updated café.txt");
    });

    it("stores a string, a typed array and a custom identity and time", async function () {
      await commit({ store, cache, lock, path: "/s.txt", contents: "from a string" });
      await commit({ store, cache, lock, path: "/t.txt", contents: new Uint8Array([104, 105]), identity: { name: "A Person", email: "a@example.com" }, now: new Date(T0) });

      const bare = await exportRepo();
      expect(fx.text(bare, ["show", MASTER + ":s.txt"])).toBe("from a string");
      expect(fx.text(bare, ["show", MASTER + ":t.txt"])).toBe("hi");
      expect(fx.text(bare, ["log", "-1", "--format=%an <%ae>|%cn <%ce>|%at", MASTER])).toBe("A Person <a@example.com>|A Person <a@example.com>|" + T0 / 1000);

      const error = await commit({ store, cache, lock, path: "/n.txt", contents: "x", identity: { name: "Bad\nName", email: "a@example.com" } }).then(() => null, (err) => err);
      expect(error).toEqual(jasmine.any(Error));
    });

    it("makes one pack of whole objects, an index and a reverse index, and a history piece with just the commit", async function () {
      const before = await manifest.read(store);
      const result = await commit({ store, cache, lock, path: "/posts/2024/c.txt", contents: Buffer.from("C\n") });
      const current = await manifest.read(store);

      expect(current.seq).toBe(before.seq + 1);
      expect(current.refs[MASTER]).toBe(result.commit);
      expect(current.head).toBe(MASTER);
      expect(current.snapshots[current.snapshots.length - 1].refs[MASTER]).toBe(result.commit);

      const pack = current.packs[current.packs.length - 1];
      const piece = current.historyPieces[0];
      expect(current.packs.length).toBe(before.packs.length + 1);
      expect(piece.seq).toBe(current.seq);

      // The blob, the three trees on the path and the root's, and the commit
      expect(pack.objects).toBe(1 + 3 + 1);
      expect(piece.objects).toBe(1);

      for (const entry of [pack, piece]) {
        expect((await store.head(packKey(entry.name))).size).toBe(entry.size);
        expect((await store.head(idxKey(entry.name))).size).toBe(entry.idxSize);
        expect(await store.head(revKey(entry.name))).not.toBeNull();
      }

      const bare = await expectGitHappy();
      const entries = fx.listEntries({ pack: await store.get(packKey(pack.name)), idx: await store.get(idxKey(pack.name)) });
      expect(entries.map((e) => e.type).sort()).toEqual(["blob", "commit", "tree", "tree", "tree"]);
      // Whole objects: nothing is a delta, so the pack stands alone
      expect(entries.every((e) => e.depth === 0)).toBe(true);
      // The contents are the last entry
      expect(entries[entries.length - 1].type).toBe("blob");

      const pieceEntries = fx.listEntries({ pack: await store.get(packKey(piece.name)), idx: await store.get(idxKey(piece.name)) });
      expect(pieceEntries.map((e) => [e.oid, e.type])).toEqual([[result.commit, "commit"]]);
      expect(fx.text(bare, ["rev-list", "--count", MASTER])).toBe("2");
    });

    it("is read back by the reader, as git reads it", async function () {
      const result = await commit({ store, cache, lock, path: "/posts/c.txt", contents: Buffer.from("C\n") });
      const current = await manifest.read(store);
      const reader = createReader({ store, cache, packs: current.packs });
      const bare = await exportRepo();

      const expected = fx.catAll(bare, fx.text(bare, ["rev-list", "--objects", MASTER]).split("\n").map((l) => l.split(" ")[0]));
      for (const [oid, object] of expected) {
        const found = await reader.read(oid);
        expect(found.type).toBe(object.type);
        expect(found.data.equals(object.data)).toBe(true);
      }
      expect(expected.has(result.commit)).toBe(true);
    });
  });

  describe("on an empty repository", function () {
    beforeEach(() => setup({ seeded: false }));
    afterEach(teardown);

    it("makes a root commit that plumbing.js would make", async function () {
      const oracle = path.join(dir, "oracle.git");
      fx.git(dir, ["init", "-q", "--bare", "-b", "master", oracle]);

      const first = await commit({ store, cache, lock, path: "/Folder/Post.txt", contents: Buffer.from("Hello"), now: T0 });
      expect(first.commit).toBe(plumbing(oracle, "Folder/Post.txt", Buffer.from("Hello"), T0));
      expect(first.parent).toBeNull();

      const current = await manifest.read(store);
      expect(current.seq).toBe(1);
      expect(current.head).toBe(MASTER);

      // Emptying the repository is a commit of the empty tree
      const emptied = await commit({ store, cache, lock, path: "/Folder", remove: true, now: T0 + 1000 });
      expect(emptied.commit).toBe(plumbing(oracle, "Folder", null, T0 + 1000));

      const bare = await expectGitHappy();
      expect(fx.text(bare, ["log", "--format=%s", MASTER])).toBe("Removed Folder\nUpdated Folder/Post.txt");
      expect(fx.text(bare, ["ls-tree", MASTER])).toBe("");
    });

    it("writes the empty file", async function () {
      const result = await commit({ store, cache, lock, path: "/empty.txt", contents: Buffer.alloc(0) });
      expect(result.changed).toBe(true);
      expect(fx.text(await expectGitHappy(), ["ls-tree", MASTER])).toBe("100644 blob e69de29bb2d1d6434b8b29ae775ad8c2e48c5391\tempty.txt");
    });
  });

  describe("against pushes and other commits", function () {
    beforeEach(() => setup());
    afterEach(teardown);

    // A push of one more commit from the client, through receive()
    async function pushFromClient(file, text) {
      const tip = (() => {
        const current = fx.text(src, ["rev-parse", "HEAD"]);
        fs.writeFileSync(path.join(src, file), text);
        fx.git(src, ["add", "-A"]);
        fx.git(src, ["commit", "-q", "-m", "Pushed " + file]);
        const made = fx.text(src, ["rev-parse", "HEAD"]);
        return { old: current, new: made };
      })();
      const pack = fx.packRevs(src, [tip.new], [tip.old], { thin: true });
      const result = await receive({ store, cache, lock, commands: [{ old: tip.old, new: tip.new, ref: MASTER }], pack: Readable.from([pack]) });
      expect(result.outcome).toBe("ok");
      return tip.new;
    }

    // Makes `competing` happen once, just before the commit's first swap
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

    it("starts again on the new master when a push gets in first, and loses neither", async function () {
      let pushed;
      const racing = raceOnce(async () => (pushed = await pushFromClient("pushed.txt", "From the user\n")));

      const result = await commit({ store, cache, lock: racing, path: "/from-blot.txt", contents: Buffer.from("From Blot\n") });

      expect(result.changed).toBe(true);
      expect(result.parent).toBe(pushed);
      expect((await manifest.read(store)).seq).toBe(3);

      const bare = await expectGitHappy();
      expect(fx.text(bare, ["ls-tree", "--name-only", MASTER]).split("\n")).toEqual(jasmine.arrayContaining(["from-blot.txt", "pushed.txt"]));
      expect(fx.text(bare, ["rev-parse", MASTER + "^"])).toBe(pushed);
    });

    it("keeps the pack it uploaded when the swap is lost to something which left master alone", async function () {
      const racing = raceOnce(async () => {
        const base = await manifest.read(store);
        await manifest.swap({ store, lock, base, next: manifest.advance(base, { refs: { ...base.refs, "refs/tags/v1": head } }) });
      });

      const result = await commit({ store, cache, lock: racing, path: "/from-blot.txt", contents: Buffer.from("From Blot\n") });
      expect(result.changed).toBe(true);
      expect(result.seq).toBe(3);

      // Uploaded once: the pack and the history piece (and the seed's)
      expect(store.calls.filter((call) => /^put packs\/.*\.pack$/.test(call)).length).toBe(3);
      const current = await manifest.read(store);
      expect(current.refs["refs/tags/v1"]).toBe(head);
      expect(current.refs[MASTER]).toBe(result.commit);
      await expectGitHappy();
    });

    it("gives EMOVED after three lost swaps, with the manifest as the others left it", async function () {
      let tags = 0;
      const racing = async (fn) => {
        const base = await manifest.read(store);
        await manifest.swap({ store, lock, base, next: manifest.advance(base, { refs: { ...base.refs, ["refs/tags/t" + ++tags]: head } }) });
        return lock(fn);
      };

      const error = await commit({ store, cache, lock: racing, path: "/from-blot.txt", contents: Buffer.from("From Blot\n") }).then(() => null, (err) => err);
      expect(error.code).toBe("EMOVED");
      expect(tags).toBe(3);

      const current = await manifest.read(store);
      expect(current.refs[MASTER]).toBe(head);
      expect(current.packs.length).toBe(1);
      expect(current.historyPieces).toEqual([]);
    });

    it("makes three writes at once, one after another, losing none", async function () {
      const names = ["a", "b", "c"];
      const results = await Promise.all(names.map((name) => commit({ store, cache, lock, path: "/" + name + ".txt", contents: Buffer.from(name) })));
      expect(results.every((r) => r.changed)).toBe(true);

      const bare = await expectGitHappy();
      expect(fx.text(bare, ["ls-tree", "--name-only", MASTER]).split("\n")).toEqual(jasmine.arrayContaining(["a.txt", "b.txt", "c.txt"]));
      expect(fx.text(bare, ["rev-list", "--count", MASTER])).toBe("4");
    });
  });

  describe("when the store fails", function () {
    beforeEach(() => setup());
    afterEach(teardown);

    it("leaves the manifest as it was when an upload fails, and a later commit works", async function () {
      const before = await manifest.read(store);
      store.inject("put", { key: /\.idx$/, before: dropped() });

      const error = await commit({ store, cache, lock, path: "/a.txt", contents: Buffer.from("A") }).then(() => null, (err) => err);
      expect(error.code).toBe("ECONNRESET");

      expect(await manifest.read(store)).toEqual(before);
      expect(store.calls.filter((call) => call.startsWith("putIfAbsent"))).toEqual(["putIfAbsent " + manifestKey(1)]); // the seed's

      const again = await commit({ store, cache, lock, path: "/a.txt", contents: Buffer.from("A") });
      expect(again.changed).toBe(true);
      await expectGitHappy();
    });

    it("returns an unknown outcome, not a success or a failure, when the swap cannot be read back", async function () {
      const key = manifestKey(2);
      store.inject("putIfAbsent", { key, after: dropped() }).inject("get", { key, before: dropped() });

      const result = await commit({ store, cache, lock, path: "/a.txt", contents: Buffer.from("A") });

      expect(result.outcome).toBe("unknown");
      expect(result.changed).toBeNull();
      expect(result.error).toEqual(jasmine.any(OutcomeUnknownError));
      expect(result.error.code).toBe("OUTCOME_UNKNOWN");
      expect(result.commit).toMatch(/^[0-9a-f]{40}$/);
    });

    it("counts a swap which landed but lost its answer as made", async function () {
      store.inject("putIfAbsent", { key: manifestKey(2), after: dropped() });

      const result = await commit({ store, cache, lock, path: "/a.txt", contents: Buffer.from("A") });
      expect(result).toEqual(jasmine.objectContaining({ outcome: "ok", changed: true }));
      expect((await manifest.read(store)).refs[MASTER]).toBe(result.commit);
    });
  });

  describe("a large file", function () {
    const scratchLeft = () => {
      const scratch = path.join(dir, "cache", "scratch");
      return fs.existsSync(scratch) ? fs.readdirSync(scratch) : [];
    };

    // Random bytes, in chunks, handed out only as the reader asks
    function chunked(seed, total, chunk = 64 * 1024) {
      const bytes = fx.bytes(seed, total);
      let produced = 0;
      const stream = Readable.from(
        (async function* () {
          for (let at = 0; at < total; at += chunk) {
            produced = at + chunk;
            yield bytes.subarray(at, at + chunk);
          }
        })(),
        { objectMode: false }
      );
      return { bytes, stream, produced: () => produced };
    }

    beforeEach(() => setup());
    afterEach(teardown);

    it("is hashed and packed from a stream of known size, through scratch which is then released", async function () {
      const file = chunked(5, 3 * MiB);
      const result = await commit({ store, cache, lock, path: "/big/large.bin", contents: file.stream, size: file.bytes.length });

      expect(result.changed).toBe(true);
      expect(file.produced()).toBeGreaterThanOrEqual(file.bytes.length);

      const bare = await expectGitHappy();
      expect(fx.git(bare, ["show", MASTER + ":big/large.bin"]).equals(file.bytes)).toBe(true);
      expect(fx.text(bare, ["cat-file", "-s", MASTER + ":big/large.bin"])).toBe(String(file.bytes.length));
      expect(scratchLeft()).toEqual([]);
      expect(cache.stats().reservedBytes).toBe(0);
    });

    it("is counted first when the stream's size is not known", async function () {
      const file = chunked(6, 2 * MiB + 123);
      const result = await commit({ store, cache, lock, path: "/large.bin", contents: file.stream });

      expect(result.changed).toBe(true);
      const bare = await expectGitHappy();
      expect(fx.git(bare, ["show", MASTER + ":large.bin"]).equals(file.bytes)).toBe(true);
      expect(scratchLeft()).toEqual([]);
    });

    it("is the same commit whether it comes as a stream or a Buffer, and a second write of it is a no-op", async function () {
      const bytes = fx.bytes(7, 2 * MiB);
      const made = await commit({ store, cache, lock, path: "/big.bin", contents: Readable.from([bytes], { objectMode: false }), size: bytes.length, now: T0 });
      const oracle = path.join(dir, "oracle.git");
      fx.git(dir, ["clone", "-q", "--bare", src, oracle]);
      expect(made.commit).toBe(plumbing(oracle, "big.bin", bytes, T0));

      const again = await commit({ store, cache, lock, path: "/big.bin", contents: bytes });
      expect(again.changed).toBe(false);
      expect(scratchLeft()).toEqual([]);
    });

    it("is refused, with nothing written, when the stream is not the size it was said to be", async function () {
      const writes = { ...inner.stats };
      for (const size of [100, 4 * MiB]) {
        const file = chunked(8, 2 * MiB);
        const error = await commit({ store, cache, lock, path: "/large.bin", contents: file.stream, size }).then(() => null, (err) => err);
        expect(error).toEqual(jasmine.any(Error));
      }
      expect(used(writes)).toEqual(jasmine.objectContaining({ puts: 0, putIfAbsents: 0 }));
      expect(scratchLeft()).toEqual([]);
      expect(cache.stats().reservedBytes).toBe(0);
    });

    it("is refused over the limit, and when the cache has no room for its scratch space", async function () {
      const writes = { ...inner.stats };

      let error = await commit({ store, cache, lock, path: "/large.bin", contents: chunked(9, 2 * MiB).stream, size: 2 * MiB, limit: MiB }).then(() => null, (err) => err);
      expect(error).toEqual(jasmine.any(TooLargeError));

      error = await commit({ store, cache, lock, path: "/large.bin", contents: Buffer.alloc(MiB + 1), limit: MiB }).then(() => null, (err) => err);
      expect(error).toEqual(jasmine.any(TooLargeError));

      const small = createCache({ dir: path.join(dir, "small"), maxBytes: 256 * 1024 });
      error = await commit({ store, cache: small, lock, path: "/large.bin", contents: chunked(10, 2 * MiB).stream, size: 2 * MiB }).then(() => null, (err) => err);
      expect(error).toEqual(jasmine.any(NoRoomError));

      expect(used(writes)).toEqual(jasmine.objectContaining({ puts: 0, putIfAbsents: 0 }));
      expect(small.stats().reservedBytes).toBe(0);
    });
  });

  describe("requests", function () {
    beforeEach(() => setup());
    afterEach(teardown);

    // The store as a fresh process sees it: nothing remembered about manifests
    const fresh = () => (store = faults(inner));

    async function measure(write) {
      const before = { ...inner.stats };
      await write();
      const spent = used(before);
      return { ...spent, reading: spent.heads + spent.reads + spent.gets, writing: spent.puts + spent.putIfAbsents };
    }

    it("takes a fixed number for a one-file commit once the trees are warm", async function () {
      if (!warm) return pending("the cache needs zlib.crc32 (Node 22), which this Node lacks");

      await commit({ store, cache, lock, path: "/posts/2024/first.txt", contents: Buffer.from("First\n") });
      const spent = await measure(() => commit({ store, cache, lock, path: "/posts/2024/second.txt", contents: Buffer.from("Second\n") }));

      // Reading: the hint, and a HEAD for what follows it. The manifest's bytes
      // are kept from the last swap, and the commit and trees are in the cache.
      expect(spent.gets).toBe(1);
      expect(spent.reads).toBe(0);
      expect(spent.lists).toBe(0);

      // Writing: the pack, index and reverse index, the same for the history
      // piece, the manifest and the hint
      expect(spent.puts).toBe(6 + 1);
      expect(spent.putIfAbsents).toBe(1);

      // Checking, in manifest.swap: the four files it is about to name, and
      // that the manifest after this one is not there, twice
      expect(spent.heads).toBe(1 + 4 + 2);

      expect(spent.reading + spent.writing).toBe(16);
    });

    it("takes the same number however deep the history is", async function () {
      if (!warm) return pending("the cache needs zlib.crc32 (Node 22), which this Node lacks");

      await commit({ store, cache, lock, path: "/posts/a-1.txt", contents: Buffer.from("1") });
      const few = await measure(() => commit({ store, cache, lock, path: "/posts/a-2.txt", contents: Buffer.from("2") }));
      for (let i = 3; i < 12; i++) await commit({ store, cache, lock, path: "/posts/a-" + i + ".txt", contents: Buffer.from(String(i)) });
      const many = await measure(() => commit({ store, cache, lock, path: "/posts/a-12.txt", contents: Buffer.from("12") }));

      // (the bytes differ: the manifest is a little bigger)
      delete few.bytesRead;
      delete many.bytesRead;
      expect(many).toEqual(few);
    });

    it("reads the commit and the trees by range when nothing is cached, and then caches them", async function () {
      fresh();
      const emptyCache = createCache({ dir: path.join(dir, "cold-cache"), maxBytes: 64 * MiB });
      const cold = await measure(() => commit({ store, cache: emptyCache, lock, path: "/posts/2024/cold.txt", contents: Buffer.from("Cold\n") }));

      // The manifest, then the index of the one pack and the entries of the
      // commit and the three trees. None of it grows with the history.
      expect(cold.reads).toBeGreaterThan(0);
      expect(cold.lists).toBe(0);
      expect(cold.reading).toBeLessThanOrEqual(warm ? 20 : 26); // without a cache, index parts are fetched again
      expect(cold.writing).toBe(8);

      if (!warm) return;
      fresh();
      const next = await measure(() => commit({ store, cache: emptyCache, lock, path: "/posts/2024/next.txt", contents: Buffer.from("Next\n") }));
      expect(next.reads).toBe(0);
    });

    it("makes no requests beyond the manifest for a write which changes nothing", async function () {
      await commit({ store, cache, lock, path: "/same.txt", contents: Buffer.from("same") });
      const spent = await measure(() => commit({ store, cache, lock, path: "/same.txt", contents: Buffer.from("same") }));
      expect(spent.writing).toBe(0);
    });
  });
});
