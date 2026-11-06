// Importing an existing repository into the store, against repositories made
// with real git: branches, merges, lightweight, annotated and nested tags, a
// large file edited a little at a time (so git stores deltas), and the things
// that must be left behind (unreachable objects, a stash, remote-tracking refs
// and notes). After an import a real `git clone` from the store must pass
// `transfer.fsckObjects` and `git fsck --strict`, a push through receive must
// work on top of it, compaction must leave its one pack alone and the folder
// materialize makes must be the one `git checkout` makes.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const fx = require("./helpers/fixture");
const faults = require("./helpers/faults");
const timeout = require("./helpers/timeout");
const { createReceiveServer, push } = require("./helpers/receiveServer");
const { startServer, runGit } = require("./helpers/upload-server");
const { listFiles } = require("./helpers/repo");
const manifest = require("../manifest");
const importRepo = require("../import");
const { verifyImport } = importRepo;
const compact = require("../compact");
const createCache = require("../cache");
const createMemoryStore = require("../objectStore/memory");
const createReader = require("../reader");
const createFolderSink = require("../folderSink");
const materialize = require("../materialize");
const { readHistory } = require("../history");
const { idxKey, revKey, packKey } = require("../layout");
const { OutcomeUnknownError, CorruptError } = require("../errors");

const MiB = 1024 * 1024;
const lock = (fn) => fn();

function lines(version) {
  const out = [];
  for (let i = 0; i < 400; i++)
    out.push(
      "line " +
        i +
        " " +
        (i % 40 === version % 40 ? "edited " + version : "same") +
        " " +
        ((i * 7919 + version) % 1000)
    );
  return out.join("\n") + "\n";
}

// A repository with `rich` history in `dir`: master with edits to a text file
// and a 1.5 MiB binary one, two images, a dev branch merged back, another
// branch not merged, a lightweight tag, an annotated tag and a tag of that tag
function buildRich(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fx.git(dir, ["init", "-q", "-b", "master"]);
  const binary = fx.bytes(5, 1536 * 1024);
  let n = 0;

  function commitEdit(message, extra = {}) {
    n++;
    fs.mkdirSync(path.join(dir, "docs"), { recursive: true });
    fs.mkdirSync(path.join(dir, "img"), { recursive: true });
    fs.writeFileSync(path.join(dir, "docs", "big.txt"), lines(n));
    binary[(n * 4099) % binary.length] ^= 0xff;
    fs.writeFileSync(path.join(dir, "large.bin"), binary);
    fs.writeFileSync(
      path.join(dir, "post-" + n + ".md"),
      "# Post " + n + "\n" + lines(n % 3).slice(0, 2000)
    );
    if (n === 2)
      fs.writeFileSync(path.join(dir, "img", "a.png"), fx.bytes(21, 30000));
    if (n === 5)
      fs.writeFileSync(path.join(dir, "img", "b.png"), fx.bytes(22, 40000));
    for (const [name, contents] of Object.entries(extra))
      fs.writeFileSync(path.join(dir, name), contents);
    fx.git(dir, ["add", "-A"]);
    fx.git(dir, ["commit", "-q", "-m", message]);
  }

  for (let i = 1; i <= 3; i++) commitEdit("Commit " + i);
  fx.git(dir, ["checkout", "-q", "-b", "dev"]);
  fs.writeFileSync(path.join(dir, "dev-1.md"), "dev one\n");
  fx.git(dir, ["add", "-A"]);
  fx.git(dir, ["commit", "-q", "-m", "Dev one"]);
  fs.writeFileSync(path.join(dir, "dev-2.md"), "dev two\n");
  fx.git(dir, ["add", "-A"]);
  fx.git(dir, ["commit", "-q", "-m", "Dev two"]);
  fx.git(dir, ["checkout", "-q", "-b", "wip", "master"]);
  fs.writeFileSync(path.join(dir, "wip.md"), "work in progress\n");
  fx.git(dir, ["add", "-A"]);
  fx.git(dir, ["commit", "-q", "-m", "Wip"]);
  fx.git(dir, ["checkout", "-q", "master"]);
  for (let i = 4; i <= 5; i++) commitEdit("Commit " + i);
  fx.git(dir, ["merge", "-q", "--no-ff", "-m", "Merge dev", "dev"]);
  commitEdit("Commit 6");

  fx.git(dir, ["tag", "light", "HEAD~2"]);
  fx.git(dir, ["tag", "-a", "v1", "-m", "Version 1", "HEAD~1"]);
  fx.git(dir, [
    "tag",
    "-a",
    "v1-again",
    "-m",
    "A tag of the tag",
    fx.text(dir, ["rev-parse", "v1"]),
  ]);
  fx.git(dir, ["tag", "-a", "v2", "-m", "Version 2", "HEAD"]);
}

// What an import must leave behind: an unreachable blob and commit, a stash, a
// ref only under refs/remotes, and a note
function addLeftovers(dir) {
  fx.git(
    dir,
    ["hash-object", "-w", "--stdin"],
    "an object nothing points at\n"
  );
  const orphanTree = fx.text(dir, ["write-tree"]);
  fx.git(dir, ["commit-tree", orphanTree, "-m", "orphan"]);

  fs.appendFileSync(path.join(dir, "docs", "big.txt"), "an uncommitted edit\n");
  fx.git(dir, ["stash", "-q"]);

  fx.git(dir, ["checkout", "-q", "-b", "tmp"]);
  fs.writeFileSync(
    path.join(dir, "remote-only.md"),
    "only a remote has this\n"
  );
  fx.git(dir, ["add", "-A"]);
  fx.git(dir, ["commit", "-q", "-m", "Remote only"]);
  fx.git(dir, ["update-ref", "refs/remotes/origin/tmp", "HEAD"]);
  fx.git(dir, ["checkout", "-q", "master"]);
  fx.git(dir, ["branch", "-q", "-D", "tmp"]);

  fx.git(dir, ["notes", "add", "-m", "a note", "HEAD"]);
}

// A hash of every file under `dir`: path, mode and contents
function fingerprint(dir) {
  const hash = crypto.createHash("sha256");
  (function walk(current) {
    for (const name of fs.readdirSync(current).sort()) {
      const file = path.join(current, name);
      const stat = fs.lstatSync(file);
      hash.update(
        path.relative(dir, file) + "\0" + (stat.mode & 0o7777) + "\0"
      );
      if (stat.isDirectory()) walk(file);
      else if (stat.isSymbolicLink()) hash.update(fs.readlinkSync(file));
      else hash.update(fs.readFileSync(file));
    }
  })(dir);
  return hash.digest("hex");
}

const refsOf = (dir) =>
  Object.fromEntries(
    fx
      .text(dir, [
        "for-each-ref",
        "--format=%(refname) %(objectname)",
        "refs/heads",
        "refs/tags",
      ])
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split(" "))
  );

describe("git store import", function () {
  timeout(180 * 1000);

  let root;
  let rich; // the working tree of the rich repository
  let counter = 0;

  beforeAll(function () {
    root = fx.tempDir();
    rich = path.join(root, "rich");
    buildRich(rich);
    addLeftovers(rich);
  });

  afterAll(function () {
    fx.remove(root);
  });

  // A memory store, a cache, and the pieces importRepo wants
  function setup({ maxBytes = 64 * MiB, wrap = (store) => store } = {}) {
    const inner = createMemoryStore();
    const dir = path.join(root, "cache-" + ++counter);
    return {
      inner,
      store: wrap(inner),
      cache: createCache({ dir, maxBytes }),
      cacheDir: dir,
    };
  }

  const run = (env, gitDir, options = {}) =>
    importRepo({
      store: env.store,
      cache: env.cache,
      lock,
      gitDir,
      ...options,
    });

  function scratchIsEmpty(env) {
    expect(env.cache.stats().reservedBytes).toBe(0);
    const scratch = path.join(env.cacheDir, "scratch");
    expect(fs.existsSync(scratch) ? fs.readdirSync(scratch) : []).toEqual([]);
  }

  async function oidsOf(store, name) {
    const idx = await store.get(idxKey(name));
    const { ids, count } = compact.git.idsOf(idx, name);
    return Array.from({ length: count }, (_, i) =>
      ids.subarray(i * 20, i * 20 + 20).toString("hex")
    );
  }

  describe("a repository with history, tags and things to leave behind", function () {
    let env;
    let result;
    let imported;
    let before;
    let asked;

    beforeAll(async function () {
      env = setup();
      before = fingerprint(path.join(rich, ".git"));
      result = await run(env, path.join(rich, ".git"));
      asked = { ...env.inner.stats };
      imported = await manifest.read(env.store);
    });

    it("imports every branch and tag into manifest 1, with HEAD and the peeled tags", function () {
      const source = refsOf(rich);
      expect(Object.keys(source).sort()).toEqual(
        [
          "refs/heads/dev",
          "refs/heads/master",
          "refs/heads/wip",
          "refs/tags/light",
          "refs/tags/v1",
          "refs/tags/v1-again",
          "refs/tags/v2",
        ].sort()
      );

      expect(result.outcome).toBe("imported");
      expect(result.seq).toBe(1);
      expect(result.refs).toEqual(source);
      expect(imported.seq).toBe(1);
      expect(imported.refs).toEqual(source);
      expect(imported.head).toBe("refs/heads/master");
      expect(result.head).toBe("refs/heads/master");

      // Annotated tags, and a tag of a tag, peel to the commit
      const commit = (rev) => fx.text(rich, ["rev-parse", rev + "^{commit}"]);
      expect(imported.peeled).toEqual({
        [source["refs/tags/v1"]]: commit("v1"),
        [source["refs/tags/v1-again"]]: commit("v1"),
        [source["refs/tags/v2"]]: commit("v2"),
      });
    });

    it("writes one pack with seq 1, one snapshot and a history pack through seq 1, and no pieces", function () {
      expect(imported.packs.length).toBe(1);
      expect(imported.packs[0].seq).toBe(1);
      expect(imported.packs[0].name).toBe(result.pack.name);
      expect(imported.snapshots).toEqual([{ seq: 1, refs: imported.refs }]);
      expect(imported.history.through).toBe(1);
      expect(imported.history.name).toBe(result.history.name);
      expect(imported.historyPieces).toEqual([]);
      expect(imported.writer).toMatch(/^[0-9a-f]{32}$/);
    });

    it("packs exactly what the branches and tags reach, and leaves the rest behind", async function () {
      const reachable = new Set(
        fx
          .text(rich, ["rev-list", "--objects", "--branches", "--tags"])
          .split("\n")
          .map((line) => line.slice(0, 40))
      );
      const packed = await oidsOf(env.store, imported.packs[0].name);
      expect(new Set(packed)).toEqual(reachable);
      expect(packed.length).toBe(result.pack.objects);

      const all = fx
        .text(rich, [
          "cat-file",
          "--batch-all-objects",
          "--batch-check=%(objectname)",
        ])
        .split("\n");
      expect(all.length).toBeGreaterThan(packed.length + 5);
      const stash = fx.text(rich, ["rev-parse", "refs/stash"]);
      expect(packed).not.toContain(stash);
      expect(packed).not.toContain(
        fx.text(rich, ["rev-parse", "refs/remotes/origin/tmp"])
      );
      expect(packed).not.toContain(
        fx.text(rich, ["rev-parse", "refs/notes/commits"])
      );

      expect(result.skipped.map((skip) => skip.ref).sort()).toEqual([
        "refs/notes/commits",
        "refs/remotes/origin/tmp",
        "refs/stash",
      ]);
    });

    it("writes a history pack of every commit and nothing else, and a .rev for the main pack only", async function () {
      const commits = fx
        .text(rich, ["rev-list", "--branches", "--tags"])
        .split("\n")
        .sort();
      const graph = await readHistory({ store: env.store, manifest: imported });
      expect(graph.size).toBe(commits.length);
      expect(result.history.commits).toBe(commits.length);
      for (const oid of commits) {
        expect(graph.parents(oid)).toEqual(
          fx
            .text(rich, ["rev-list", "--parents", "-n", "1", oid])
            .split(" ")
            .slice(1)
        );
      }

      expect(
        await env.store.head(revKey(imported.packs[0].name))
      ).not.toBeNull();
      expect(await env.store.head(revKey(imported.history.name))).toBeNull();
      expect((await env.store.head(packKey(imported.history.name))).size).toBe(
        imported.history.size
      );
    });

    it("reads every object back through the store as git has it", async function () {
      const reader = createReader({
        store: env.store,
        cache: env.cache,
        packs: imported.packs,
      });
      const oids = fx
        .text(rich, ["rev-list", "--objects", "--branches", "--tags"])
        .split("\n")
        .map((line) => line.slice(0, 40));
      const oracle = fx.catAll(rich, oids);
      for (const [oid, { type, data }] of oracle) {
        const found = await reader.read(oid);
        expect(found && found.type).toBe(type, oid);
        expect(found && found.data.equals(data)).toBe(true, oid);
      }
    });

    it("did not change the source by a byte, and released its scratch space", function () {
      expect(fingerprint(path.join(rich, ".git"))).toBe(before);
      scratchIsEmpty(env);
    });

    it("makes requests which do not depend on the size: 9, and the ones the manifest swap makes", function () {
      expect(result.stats.requests).toEqual({
        total: 9,
        gets: 1,
        lists: 1,
        puts: 6,
        putIfAbsents: 1,
      });
      expect(asked.puts).toBe(6);
      expect(asked.putIfAbsents).toBe(1);
      expect(asked.heads).toBe(0);
      expect(result.stats.bytesUp).toBeGreaterThan(result.pack.size);
    });

    it("passes git's checks as a clone, and the clone has the source's refs", async function () {
      const server = await startServer({
        store: env.store,
        cache: env.cache,
        manifest: () => manifest.read(env.store),
      });
      try {
        const target = path.join(root, "clone-" + ++counter);
        const cloned = await runGit([
          "-c",
          "transfer.fsckObjects=true",
          "clone",
          "-q",
          server.url,
          target,
        ]);
        expect(cloned.code).toBe(0, cloned.stderr);
        expect(server.errors).toEqual([]);

        fx.git(target, ["fsck", "--strict", "--no-dangling"]);
        const found = {};
        for (const line of fx
          .text(target, [
            "for-each-ref",
            "--format=%(refname) %(objectname)",
            "refs/remotes/origin",
            "refs/tags",
          ])
          .split("\n")
          .filter(Boolean)) {
          const [ref, oid] = line.split(" ");
          if (ref !== "refs/remotes/origin/HEAD")
            found[ref.replace("refs/remotes/origin/", "refs/heads/")] = oid;
        }
        expect(found).toEqual(refsOf(rich));
        expect(fx.text(target, ["rev-parse", "HEAD"])).toBe(
          fx.text(rich, ["rev-parse", "refs/heads/master"])
        );
      } finally {
        await server.close();
      }
    });

    it("verifyImport agrees", async function () {
      const verified = await verifyImport({
        store: env.store,
        cache: env.cache,
        gitDir: path.join(rich, ".git"),
      });
      expect(verified.refs).toBe(7);
      scratchIsEmpty(env);
    });

    it("leaves a single pack for compaction to leave alone", async function () {
      const outcome = await compact({
        store: env.store,
        cache: env.cache,
        lock,
      });
      expect(outcome.outcome).toBe("nothing");
      expect((await manifest.read(env.store)).seq).toBe(1);
    });

    it("materializes from the empty tree the folder git checks out", async function () {
      const reader = createReader({
        store: env.store,
        cache: env.cache,
        packs: imported.packs,
        scratch: env.cache,
      });
      const folder = path.join(root, "folder-" + ++counter);
      fs.mkdirSync(folder);
      await materialize({
        reader,
        from: null,
        to: imported.refs["refs/heads/master"],
        sink: createFolderSink({ root: folder }),
      });

      const checkout = path.join(root, "checkout-" + ++counter);
      fx.git(root, [
        "clone",
        "-q",
        "--no-hardlinks",
        path.join(rich, ".git"),
        checkout,
      ]);
      fs.rmSync(path.join(checkout, ".git"), { recursive: true });
      expect(listFiles(folder)).toEqual(listFiles(checkout));
    });
  });

  describe("on top of an import", function () {
    it("takes a push through receive, and a client which cloned before fetches it", async function () {
      const env = setup();
      await run(env, path.join(rich, ".git"));
      const lockOf = (() => {
        let tail = Promise.resolve();
        return (fn) => {
          const next = tail.then(fn);
          tail = next.catch(() => {});
          return next;
        };
      })();
      const received = await createReceiveServer({
        store: env.store,
        cache: env.cache,
        lock: lockOf,
      });
      const server = await startServer({
        store: env.store,
        cache: env.cache,
        manifest: () => manifest.read(env.store),
      });

      try {
        const clone = async (name) => {
          const target = path.join(root, name + "-" + ++counter);
          const cloned = await runGit([
            "-c",
            "transfer.fsckObjects=true",
            "clone",
            "-q",
            server.url,
            target,
          ]);
          expect(cloned.code).toBe(0, cloned.stderr);
          return target;
        };
        const early = await clone("early");
        const writer = await clone("writer");

        // A push: an edit of the large file, so its pack is thin against the import
        fs.appendFileSync(
          path.join(writer, "docs", "big.txt"),
          "pushed after the import\n"
        );
        fs.writeFileSync(path.join(writer, "new-post.md"), "# New\n");
        fx.git(writer, ["add", "-A"]);
        fx.git(writer, ["commit", "-q", "-m", "After the import"]);
        const pushed = await push(writer, ["-q", received.url, "master"]);
        expect(pushed.code).toBe(0, pushed.stderr);

        const current = await manifest.read(env.store);
        expect(current.seq).toBe(2);
        expect(current.packs.map((pack) => pack.seq)).toEqual([1, 2]);
        expect(current.head).toBe("refs/heads/master");
        expect(current.refs["refs/heads/master"]).toBe(
          fx.text(writer, ["rev-parse", "HEAD"])
        );

        const fetched = await runGit(
          ["-c", "transfer.fsckObjects=true", "fetch", "-q", "origin"],
          { cwd: early }
        );
        expect(fetched.code).toBe(0, fetched.stderr);
        fx.git(early, ["fsck", "--strict", "--no-dangling"]);
        expect(
          fx.text(early, ["rev-parse", "refs/remotes/origin/master"])
        ).toBe(current.refs["refs/heads/master"]);

        // The history it left knows the new commit's parent
        const graph = await readHistory({
          store: env.store,
          manifest: current,
        });
        expect(graph.parents(current.refs["refs/heads/master"])).toEqual([
          fx.text(rich, ["rev-parse", "master"]),
        ]);
      } finally {
        await server.close();
        await received.close();
      }
    });
  });

  describe("what it refuses and what it survives", function () {
    it("refuses a repository that already has a manifest, and writes nothing", async function () {
      const env = setup();
      await run(env, path.join(rich, ".git"));
      const puts = env.inner.stats.puts;
      const before = await manifest.read(env.store);

      const error = await run(env, path.join(rich, ".git")).catch((err) => err);
      expect(error.code).toBe("ENOTEMPTY");
      expect(error.seq).toBe(1);
      expect(env.inner.stats.puts).toBe(puts);
      expect(await manifest.read(env.store)).toEqual(before);
      scratchIsEmpty(env);
    });

    it("fails clearly, without retrying, when someone else created manifest 1 first", async function () {
      const env = setup();
      const rival = manifest.serialize(
        manifest.advance(manifest.empty(), { refs: {} })
      );
      let attempts = 0;
      env.store = {
        ...env.inner,
        putIfAbsent: async (key, buffer) => {
          attempts++;
          await env.inner.putIfAbsent(key, rival);
          return env.inner.putIfAbsent(key, buffer);
        },
      };

      const error = await run(env, path.join(rich, ".git")).catch((err) => err);
      expect(error.code).toBe("EMOVED");
      expect(attempts).toBe(1);
      expect((await manifest.read(env.inner)).refs).toEqual({});
      scratchIsEmpty(env);
    });

    it("reads again and swaps when it took longer than a swap allows a base to be held", async function () {
      const env = setup();
      let now = Date.now();
      let slept = false;
      const late = (fn) => {
        if (!slept) now += manifest.MAX_BASE_AGE + 1;
        slept = true;
        return lock(fn);
      };
      const result = await importRepo({
        store: env.store,
        cache: env.cache,
        lock: late,
        gitDir: path.join(rich, ".git"),
        clock: () => now,
      });
      expect(result.outcome).toBe("imported");
      expect(result.seq).toBe(1);
      const current = await manifest.read(env.inner);
      expect(current.seq).toBe(1);
      expect(current.refs).toEqual(result.refs);
      scratchIsEmpty(env);
    });

    it("reports a swap it cannot confirm as unknown, not as a success or a failure", async function () {
      const inner = createMemoryStore();
      const store = faults(inner);
      const env = {
        store,
        inner,
        cache: createCache({
          dir: path.join(root, "cache-" + ++counter),
          maxBytes: 64 * MiB,
        }),
      };
      store.inject("putIfAbsent", {
        key: /manifests\/0*1\.json$/,
        after: Object.assign(new Error("read ECONNRESET"), {
          code: "ECONNRESET",
        }),
      });
      store.inject("get", {
        key: /manifests\/0*1\.json$/,
        before: new Error("read ECONNRESET"),
      });

      const result = await run(env, path.join(rich, ".git"));
      expect(result.outcome).toBe("unknown");
      expect(result.error instanceof OutcomeUnknownError).toBe(true);
      expect(result.seq).toBe(1);
    });

    it("releases its scratch space when an upload fails, and leaves the manifest as it was", async function () {
      const env = setup({ wrap: faults });
      env.store.inject("put", {
        key: /\.pack$/,
        before: new Error("the store is down"),
        times: 2,
      });

      const error = await run(env, path.join(rich, ".git")).catch((err) => err);
      expect(error.message).toBe("the store is down");
      expect((await manifest.read(env.inner)).seq).toBe(0);
      scratchIsEmpty(env);
    });

    it("fails with NoRoomError when the repository could not fit in the cache, and says what to do", async function () {
      const env = setup({ maxBytes: 64 * 1024 });
      const error = await run(env, path.join(rich, ".git")).catch((err) => err);
      expect(error.code).toBe("NO_ROOM");
      expect(error.message).toContain("scratchDir");
      expect((await manifest.read(env.inner)).seq).toBe(0);
      scratchIsEmpty(env);
    });

    it("builds in a scratchDir of the host's instead, with no cache, and removes what it made", async function () {
      const inner = createMemoryStore();
      const scratchDir = path.join(root, "big-disk-" + ++counter);
      const result = await importRepo({
        store: inner,
        lock,
        gitDir: path.join(rich, ".git"),
        scratchDir,
      });

      expect(result.outcome).toBe("imported");
      expect(fs.readdirSync(scratchDir)).toEqual([]);
      expect((await manifest.read(inner)).packs[0].name).toBe(result.pack.name);
      expect(
        (
          await verifyImport({
            store: inner,
            gitDir: path.join(rich, ".git"),
            scratchDir,
          })
        ).refs
      ).toBe(7);
      expect(fs.readdirSync(scratchDir)).toEqual([]);

      // The same pack as with a reservation: packing is deterministic
      const again = setup();
      expect((await run(again, path.join(rich, ".git"))).pack.name).toBe(
        result.pack.name
      );
    });

    it("removes the scratchDir's work when the import fails too", async function () {
      const env = setup({ wrap: faults });
      env.store.inject("put", {
        key: /\.idx$/,
        before: new Error("down"),
        times: 2,
      });
      const scratchDir = path.join(root, "big-disk-" + ++counter);

      const error = await run(env, path.join(rich, ".git"), {
        scratchDir,
      }).catch((err) => err);
      expect(error.message).toBe("down");
      expect(fs.readdirSync(scratchDir)).toEqual([]);
    });

    it("finds a mismatch when verified against a source which has moved on", async function () {
      const env = setup();
      const copy = path.join(root, "moved-" + ++counter);
      fx.git(root, [
        "clone",
        "-q",
        "--no-hardlinks",
        "--bare",
        path.join(rich, ".git"),
        copy,
      ]);
      await run(env, copy);

      fx.git(copy, [
        "update-ref",
        "refs/heads/dev",
        fx.text(copy, ["rev-parse", "master~1"]),
      ]);
      const error = await verifyImport({
        store: env.store,
        cache: env.cache,
        gitDir: copy,
      }).catch((err) => err);
      expect(error instanceof CorruptError).toBe(true);
      expect(error.message).toContain("refs/heads/dev");
    });
  });

  describe("sources which are not what they seem", function () {
    const copyOfRich = (name) => {
      const dir = path.join(root, name + "-" + ++counter);
      fx.git(root, [
        "clone",
        "-q",
        "--no-hardlinks",
        "--bare",
        path.join(rich, ".git"),
        dir,
      ]);
      return dir;
    };

    it("refuses a shallow repository, before it uploads anything", async function () {
      const dir = path.join(root, "shallow-" + ++counter);
      fx.git(root, [
        "clone",
        "-q",
        "--depth",
        "1",
        "file://" + path.join(rich, ".git"),
        dir,
      ]);
      expect(fs.existsSync(path.join(dir, ".git", "shallow"))).toBe(true);

      const env = setup();
      const error = await run(env, path.join(dir, ".git")).catch((err) => err);
      expect(error.code).toBe("ESHALLOW");
      expect(env.inner.stats.puts).toBe(0);
      expect((await manifest.read(env.inner)).seq).toBe(0);
      scratchIsEmpty(env);
    });

    it("does not publish a pack with missing parents even if the shallow file is gone", async function () {
      const dir = path.join(root, "shallow-gone-" + ++counter);
      fx.git(root, [
        "clone",
        "-q",
        "--depth",
        "1",
        "file://" + path.join(rich, ".git"),
        dir,
      ]);
      fs.rmSync(path.join(dir, ".git", "shallow"));

      const env = setup();
      const error = await run(env, path.join(dir, ".git")).catch((err) => err);
      expect(error instanceof Error).toBe(true);
      expect(env.inner.stats.puts).toBe(0);
      expect((await manifest.read(env.inner)).seq).toBe(0);
      scratchIsEmpty(env);
    });

    it("imports the real history of a repository with grafts, not the grafted one", async function () {
      const dir = copyOfRich("grafts");
      const tip = fx.text(dir, ["rev-parse", "master"]);
      fs.mkdirSync(path.join(dir, "info"), { recursive: true });
      fs.writeFileSync(path.join(dir, "info", "grafts"), tip + "\n");
      expect(fx.text(dir, ["rev-list", "--count", "master"])).toBe("1");

      const env = setup();
      const result = await run(env, dir);
      expect(result.history.commits).toBe(
        Number(fx.text(rich, ["rev-list", "--count", "--branches", "--tags"]))
      );
      expect(
        (
          await verifyImport({
            store: env.store,
            cache: env.cache,
            gitDir: dir,
          })
        ).refs
      ).toBe(7);
    });

    it("peels a tag as stored, not as a replace ref says", async function () {
      const dir = copyOfRich("replaced");
      const v1 = fx.text(dir, ["rev-parse", "refs/tags/v1"]);
      const v2 = fx.text(dir, ["rev-parse", "refs/tags/v2"]);
      fx.git(dir, ["replace", "-f", v1, v2]);
      expect(fx.text(dir, ["rev-parse", "refs/tags/v1^{commit}"])).toBe(
        fx.text(dir, ["rev-parse", "refs/tags/v2^{commit}"])
      );

      const env = setup();
      const result = await run(env, dir);
      expect(result.skipped.map((skip) => skip.ref)).toContain(
        "refs/replace/" + v1
      );
      const imported = await manifest.read(env.store);
      expect(imported.peeled[v1]).toBe(
        fx.text(rich, ["rev-parse", "refs/tags/v1^{commit}"])
      );
      expect(imported.peeled[v1]).not.toBe(imported.peeled[v2]);
      expect(
        (
          await verifyImport({
            store: env.store,
            cache: env.cache,
            gitDir: dir,
          })
        ).refs
      ).toBe(7);
    });

    it("imports from a linked worktree's directory, whose objects are in the common repository", async function () {
      const main = path.join(root, "wt-main-" + ++counter);
      fx.git(root, [
        "clone",
        "-q",
        "--no-hardlinks",
        path.join(rich, ".git"),
        main,
      ]);
      const linked = path.join(root, "wt-linked-" + counter);
      fx.git(main, ["worktree", "add", "-q", "-b", "elsewhere", linked]);
      const admin = fs
        .readFileSync(path.join(linked, ".git"), "utf8")
        .replace(/^gitdir: /, "")
        .trim();
      expect(fs.existsSync(path.join(admin, "objects"))).toBe(false);

      const env = setup({ maxBytes: 64 * MiB });
      const result = await run(env, admin);
      expect(result.outcome).toBe("imported");
      expect(result.refs["refs/heads/elsewhere"]).toBe(
        fx.text(linked, ["rev-parse", "HEAD"])
      );
      expect(result.refs["refs/heads/master"]).toBe(
        fx.text(main, ["rev-parse", "master"])
      );
      expect(result.head).toBe("refs/heads/elsewhere");
      scratchIsEmpty(env);
    });

    it("skips every one of refs whose names differ only in bytes that are not UTF-8", async function () {
      const dir = copyOfRich("odd-names");
      const tip = fx.text(dir, ["rev-parse", "master"]);
      const lines = [
        Buffer.concat([
          Buffer.from(tip + " refs/tags/x"),
          Buffer.from([0xff]),
          Buffer.from("\n"),
        ]),
        Buffer.concat([
          Buffer.from(tip + " refs/tags/x"),
          Buffer.from([0xef, 0xbf, 0xbd]),
          Buffer.from("\n"),
        ]),
      ];
      const packed = path.join(dir, "packed-refs");
      fs.appendFileSync(packed, Buffer.concat(lines));
      // git has to take them, or there is nothing to test
      const listed = fx.git(dir, [
        "for-each-ref",
        "--format=%(refname)",
        "refs/tags",
      ]);
      if (
        !listed.includes(Buffer.from([0x78, 0xff])) ||
        !listed.includes(Buffer.from([0x78, 0xef, 0xbf, 0xbd]))
      ) {
        pending("this git does not accept ref names that are not UTF-8");
        return;
      }

      const env = setup();
      const result = await run(env, dir);
      const odd = result.skipped.filter(
        (skip) => skip.why === "a name that is not valid UTF-8"
      );
      expect(odd.length).toBe(2);
      expect(
        Object.keys(result.refs).filter((ref) => ref.startsWith("refs/tags/x"))
      ).toEqual([]);
      expect(Object.keys(result.refs).length).toBe(7);
      // verify reads the source the same way and agrees
      expect(
        (
          await verifyImport({
            store: env.store,
            cache: env.cache,
            gitDir: dir,
          })
        ).refs
      ).toBe(7);
    });

    it("does not write to the source, even a temporary file: it works on a read-only copy", async function () {
      const dir = copyOfRich("readonly");
      const chmod = (mode) => {
        (function walk(current) {
          for (const entry of fs.readdirSync(current, {
            withFileTypes: true,
          })) {
            if (entry.isDirectory()) walk(path.join(current, entry.name));
          }
          fs.chmodSync(current, mode);
        })(dir);
      };
      chmod(0o555);
      try {
        const env = setup();
        expect((await run(env, dir)).outcome).toBe("imported");
      } finally {
        chmod(0o755);
      }
    });

    it("counts what a repository borrows through alternates when it reserves scratch space", async function () {
      const dir = path.join(root, "alternates-" + ++counter);
      fx.git(root, [
        "clone",
        "-q",
        "--shared",
        "--bare",
        path.join(rich, ".git"),
        dir,
      ]);
      expect(
        fs.existsSync(path.join(dir, "objects", "info", "alternates"))
      ).toBe(true);
      expect(fx.text(dir, ["count-objects", "-v"])).toContain("size-pack: 0");

      // The cache is far smaller than what the alternates hold
      const small = setup({ maxBytes: 512 * 1024 });
      const error = await run(small, dir).catch((err) => err);
      expect(error.code).toBe("NO_ROOM");
      scratchIsEmpty(small);

      const env = setup();
      const result = await run(env, dir);
      expect(result.outcome).toBe("imported");
      expect(result.pack.objects).toBeGreaterThan(50);
    });

    it("keeps the reservation up with the pack as git writes it, or stops with no room", async function () {
      const dir = copyOfRich("growth");
      const size = (await run(setup(), dir)).pack.size;
      expect(size).toBeGreaterThan(512 * 1024);

      // A guess far too low is made up for while the pack is written
      const roomy = setup();
      const imported = await run(roomy, dir, { estimateBytes: 64 * 1024 });
      expect(imported.outcome).toBe("imported");
      scratchIsEmpty(roomy);

      // And when the cache cannot hold what git writes, git is stopped
      const tight = setup({ maxBytes: Math.floor(size * 0.6) });
      const error = await run(tight, dir, { estimateBytes: 64 * 1024 }).catch(
        (err) => err
      );
      expect(error.code).toBe("NO_ROOM");
      expect((await manifest.read(tight.inner)).seq).toBe(0);
      expect(tight.inner.stats.puts).toBe(0);
      scratchIsEmpty(tight);
    });

    it("waits for the other upload to stop before it fails, so nothing reads scratch after it is gone", async function () {
      let active = 0;
      let first = true;
      const inner = createMemoryStore();
      const env = setup();
      env.store = {
        ...inner,
        put: async (key, body) => {
          active++;
          try {
            if (key.endsWith(".pack")) {
              if (first) {
                first = false;
                throw new Error("the first upload failed");
              }
              // The other pack's upload is still going when the first has failed
              await new Promise((resolve) => setTimeout(resolve, 300));
              for await (const chunk of body) void chunk;
              return;
            }
            return await inner.put(key, body);
          } finally {
            active--;
          }
        },
      };

      const error = await run(env, path.join(rich, ".git")).catch((err) => err);
      expect(error.message).toBe("the first upload failed");
      expect(active).toBe(0);
      scratchIsEmpty(env);
    });
  });

  describe("odd repositories", function () {
    const bare = (name) => {
      const dir = path.join(root, name + "-" + ++counter);
      fs.mkdirSync(dir);
      fx.git(dir, ["init", "-q", "--bare", "-b", "master"]);
      return dir;
    };

    it("writes nothing for an empty repository", async function () {
      const env = setup();
      const result = await run(env, bare("empty"));
      expect(result.outcome).toBe("empty");
      expect(result.skipped).toEqual([]);
      expect(env.inner.stats.puts).toBe(0);
      expect(env.inner.stats.putIfAbsents).toBe(0);
      expect((await manifest.read(env.inner)).seq).toBe(0);
      scratchIsEmpty(env);
    });

    it("writes nothing for a repository with only a stash", async function () {
      const dir = path.join(root, "stash-only-" + ++counter);
      fs.mkdirSync(dir);
      fx.git(dir, ["init", "-q", "-b", "master"]);
      fs.writeFileSync(path.join(dir, "a.txt"), "a\n");
      fx.git(dir, ["add", "-A"]);
      fx.git(dir, ["commit", "-q", "-m", "one"]);
      fs.writeFileSync(path.join(dir, "a.txt"), "b\n");
      fx.git(dir, ["stash", "-q"]);
      fx.git(dir, ["update-ref", "-d", "refs/heads/master"]);
      expect(fx.text(dir, ["for-each-ref", "refs/stash"])).not.toBe("");

      const env = setup();
      const result = await run(env, path.join(dir, ".git"));
      expect(result.outcome).toBe("empty");
      expect(result.skipped.map((skip) => skip.ref)).toEqual(["refs/stash"]);
      expect(env.inner.stats.puts).toBe(0);
    });

    it("takes master as HEAD when HEAD names a branch that does not exist", async function () {
      const dir = path.join(root, "head-missing-" + ++counter);
      fx.git(root, [
        "clone",
        "-q",
        "--no-hardlinks",
        "--bare",
        path.join(rich, ".git"),
        dir,
      ]);
      fx.git(dir, ["symbolic-ref", "HEAD", "refs/heads/nope"]);

      const env = setup();
      const result = await run(env, dir);
      expect(result.head).toBe("refs/heads/master");
      expect((await manifest.read(env.store)).head).toBe("refs/heads/master");
    });

    it("has no head when HEAD is missing and there is no master", async function () {
      const dir = path.join(root, "no-master-" + ++counter);
      fx.git(root, [
        "clone",
        "-q",
        "--no-hardlinks",
        "--bare",
        path.join(rich, ".git"),
        dir,
      ]);
      fx.git(dir, ["branch", "-q", "-m", "master", "trunk"]);
      fx.git(dir, ["symbolic-ref", "HEAD", "refs/heads/nope"]);

      const env = setup();
      const result = await run(env, dir);
      expect(result.head).toBeNull();
      const imported = await manifest.read(env.store);
      expect(imported.head).toBeNull();
      expect(imported.refs["refs/heads/trunk"]).toBe(
        fx.text(dir, ["rev-parse", "trunk"])
      );
    });

    it("follows HEAD to another branch when it exists", async function () {
      const dir = path.join(root, "head-dev-" + ++counter);
      fx.git(root, [
        "clone",
        "-q",
        "--no-hardlinks",
        "--bare",
        path.join(rich, ".git"),
        dir,
      ]);
      fx.git(dir, ["symbolic-ref", "HEAD", "refs/heads/dev"]);

      const env = setup();
      expect((await run(env, dir)).head).toBe("refs/heads/dev");
    });

    it("imports tags that point at a tree and a blob, and does not put them in the history", async function () {
      const dir = path.join(root, "odd-tags-" + ++counter);
      fs.mkdirSync(dir);
      fx.git(dir, ["init", "-q", "-b", "master"]);
      fs.writeFileSync(path.join(dir, "a.txt"), "a\n");
      fx.git(dir, ["add", "-A"]);
      fx.git(dir, ["commit", "-q", "-m", "one"]);
      fx.git(dir, ["tag", "-a", "of-tree", "-m", "tree", "HEAD^{tree}"]);
      fx.git(dir, ["tag", "-a", "of-blob", "-m", "blob", "HEAD:a.txt"]);
      fx.git(dir, ["tag", "bare-blob", "HEAD:a.txt"]);

      const env = setup();
      const result = await run(env, path.join(dir, ".git"));
      expect(result.outcome).toBe("imported");
      expect(result.history.commits).toBe(1);
      const imported = await manifest.read(env.store);
      expect(imported.peeled[imported.refs["refs/tags/of-tree"]]).toBe(
        fx.text(dir, ["rev-parse", "HEAD^{tree}"])
      );
      expect(imported.peeled[imported.refs["refs/tags/of-blob"]]).toBe(
        fx.text(dir, ["rev-parse", "HEAD:a.txt"])
      );
      expect(
        (
          await verifyImport({
            store: env.store,
            cache: env.cache,
            gitDir: path.join(dir, ".git"),
          })
        ).refs
      ).toBe(4);
    });

    it("imports a repository with only tags to a blob, with no history pack", async function () {
      const dir = path.join(root, "only-blob-" + ++counter);
      fs.mkdirSync(dir);
      fx.git(dir, ["init", "-q", "-b", "master"]);
      const blob = fx.text(
        dir,
        ["hash-object", "-w", "--stdin"],
        "just a blob\n"
      );
      fx.git(dir, ["tag", "lonely", blob]);

      const env = setup();
      const result = await run(env, path.join(dir, ".git"));
      expect(result.outcome).toBe("imported");
      expect(result.head).toBeNull();
      expect(result.history).toBeNull();
      const imported = await manifest.read(env.store);
      expect(imported.history).toBeNull();
      expect(imported.refs).toEqual({ "refs/tags/lonely": blob });
      expect(result.pack.objects).toBe(1);
    });
  });
});
