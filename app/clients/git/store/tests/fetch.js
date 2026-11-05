// Fetch, against real repositories: pushes go in with a real `git push` through
// receive(), and clients fetch and pull with a real `git` through serve(), then
// `git fsck --strict` and their refs are compared with the server's. The
// negotiation is also asked questions directly, to check git's wording of it.
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { PassThrough } = require("stream");
const fx = require("./helpers/fixture");
const timeout = require("./helpers/timeout");
const { createReceiveServer, push } = require("./helpers/receiveServer");
const { startServer, runGit, collect } = require("./helpers/upload-server");
const manifest = require("../manifest");
const createCache = require("../cache");
const createMemoryStore = require("../objectStore/memory");
const { serve } = require("../clone");
const receive = require("../receive");
const { negotiate } = require("../fetch");
const { advertise } = require("../advertise");

const MiB = 1024 * 1024;
const CAPS = "multi_ack_detailed no-done side-band-64k ofs-delta agent=git/test";
const IDENTITY = ["-c", "user.name=Client", "-c", "user.email=client@example.com"];

function createLock() {
  let tail = Promise.resolve();
  return (fn) => {
    const run = tail.then(fn);
    tail = run.catch(() => {});
    return run;
  };
}

const pkt = (text) => Buffer.concat([Buffer.from((text.length + 4).toString(16).padStart(4, "0")), Buffer.from(text)]);

// A request body: the wants (the first with the capabilities), the haves, and
// done or a flush
function request({ wants, haves = [], caps = CAPS, done = false }) {
  const parts = wants.map((oid, i) => pkt("want " + oid + (i === 0 ? " " + caps : "") + "\n"));
  parts.push(Buffer.from("0000"));
  for (const oid of haves) parts.push(pkt("have " + oid + "\n"));
  parts.push(done ? pkt("done\n") : Buffer.from("0000"));
  return Buffer.concat(parts);
}

// The lines git says before the pack, and whether a pack follows
function answerOf(bytes) {
  const lines = [];
  let at = 0;
  while (at + 4 <= bytes.length) {
    const length = parseInt(bytes.toString("latin1", at, at + 4), 16);
    if (length < 5 || bytes[at + 4] < 32) break;
    lines.push(bytes.toString("latin1", at + 4, at + length).replace(/\n$/, ""));
    at += length;
  }
  return { lines, pack: bytes.includes("PACK") };
}

describe("git store fetch", function () {
  timeout(180 * 1000);

  let dir;
  let work; // the pusher's repository
  let store;
  let cache;
  let received;
  let latest;
  let server;
  let counter;

  // With `shared`, the pushes and the fetches go through two cache instances
  // on one directory, as two processes on a host do
  async function setup({ commits = 5, cacheDir = "cache", shared = false, ...options } = {}) {
    dir = fx.tempDir();
    work = path.join(dir, "work");
    counter = 0;
    fx.buildFixture(work, { commits, large: false });

    store = createMemoryStore();
    cache = createCache({ dir: path.join(dir, cacheDir), maxBytes: 64 * MiB });
    const serving = shared ? createCache({ dir: path.join(dir, cacheDir), maxBytes: 64 * MiB }) : cache;
    received = await createReceiveServer({ store, cache, lock: createLock() });
    server = await startServer({ store, cache: serving, manifest: () => latest, ...options });
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

  // Pushes to the store with a real git, then reads the manifest again
  async function pushWork(...refs) {
    ok(await push(work, [received.url, ...refs]));
    await refresh();
  }

  function addCommit({ branchFrom } = {}) {
    if (branchFrom) fx.git(work, ["checkout", "-q", "-B", "side", branchFrom]);
    fs.writeFileSync(path.join(work, "posts", "new-" + ++counter + ".txt"), "A new post " + counter + "\n");
    fx.git(work, ["add", "-A"]);
    fx.git(work, ["commit", "-q", "-m", "Add " + counter]);
    return fx.text(work, ["rev-parse", "HEAD"]);
  }

  const gitIn = (cwd, ...args) => runGit(args, { cwd });

  // A clone of the store, as a user makes one
  async function clone(name, ...options) {
    const target = path.join(dir, name);
    ok(await runGit(["clone", ...options, server.url, target]));
    return target;
  }

  // The refs a fetch should have left: the server's branches and tags
  function expectMirror(client, { tags = true } = {}) {
    fx.git(client, ["fsck", "--strict", "--no-dangling"]);

    const found = {};
    const listed = fx.text(client, ["for-each-ref", "--format=%(objectname) %(refname)", "refs/remotes/origin", "refs/tags"]);
    for (const line of listed.split("\n").filter(Boolean)) {
      const [oid, ref] = line.split(" ");
      if (ref !== "refs/remotes/origin/HEAD") found[ref] = oid;
    }

    const expected = {};
    for (const [ref, oid] of Object.entries(latest.refs)) {
      if (ref.startsWith("refs/heads/")) expected["refs/remotes/origin/" + ref.slice(11)] = oid;
      else if (tags) expected[ref] = oid;
    }
    expect(found).toEqual(expected);
  }

  // Clients which have fetched a push of twenty commits and are left with only
  // the nineteenth as a ref. Git offers sixteen haves in its first round, so the
  // tip before the push is out of reach of them, and a fetch has to find where
  // the client is by walking back from the commit. Resolves [{ dir, first }].
  async function clientsInMiddleOfPush(...names) {
    const clients = [];
    for (const name of names) clients.push({ dir: await clone(name, "--no-tags") });

    const pushed = [];
    for (let i = 0; i < 20; i++) pushed.push(addCommit());
    const first = pushed[18];
    await pushWork("master");

    for (const client of clients) {
      ok(await gitIn(client.dir, "fetch", "origin"));
      fx.git(client.dir, ["checkout", "-q", "--detach", first]);
      fx.git(client.dir, ["branch", "-q", "-D", "master"]);
      fx.git(client.dir, ["update-ref", "refs/remotes/origin/master", first]);
      client.first = first;
    }
    return clients;
  }

  // A client made from the pusher's repository as it is now, and pointed at the store
  async function clientFromWork(name) {
    const target = path.join(dir, name);
    ok(await runGit(["clone", "-q", "--no-tags", "file://" + work, target]));
    fx.git(target, ["remote", "set-url", "origin", server.url]);
    return target;
  }

  const lastResult = () => server.results[server.results.length - 1];
  const posts = () => server.requests.filter((r) => r.startsWith("POST")).length;
  const used = (before) => Object.fromEntries(Object.keys(before).map((key) => [key, store.stats[key] - before[key]]));
  const reading = (u) => u.heads + u.reads + u.gets;

  describe("with the cache another process pushed through", function () {
    beforeEach(async function () {
      await setup({ shared: true });
      await pushWork("master", "refs/tags/v1");
    });
    afterEach(teardown);

    // The push kept its pack's bytes and index in the cache as it uploaded
    // them, so neither a fetch of it nor a clone asks the store for any byte
    // of a pack or an index
    it("fetches a push, and clones, reading no pack from the store", async function () {
      const client = await clone("client");
      addCommit();
      await pushWork("master");

      const before = { ...store.stats };
      ok(await gitIn(client, "fetch", "origin"));
      expect(lastResult().packs).toBe(1);
      expect(used(before)).toEqual(jasmine.objectContaining({ heads: 0, reads: 0, gets: 0 }));
      expectMirror(client);

      const cloning = { ...store.stats };
      const second = await clone("second");
      expect(used(cloning)).toEqual(jasmine.objectContaining({ heads: 0, reads: 0, gets: 0 }));
      expectMirror(second);
    });
  });

  describe("a client fetching with real git", function () {
    beforeEach(async function () {
      await setup();
      await pushWork("master", "refs/tags/v1");
    });
    afterEach(teardown);

    it("fetches one push in a single request, sending only that push's pack", async function () {
      const client = await clone("client");
      expectMirror(client);
      const clonedPacks = latest.packs.length;

      addCommit();
      await pushWork("master");
      expect(latest.packs.length).toBe(clonedPacks + 1);

      const before = { ...store.stats };
      const requests = posts();
      ok(await gitIn(client, "fetch", "origin"));

      expect(posts() - requests).toBe(1);
      expect(lastResult().packs).toBe(1);
      expect(lastResult().floor).toBe(latest.seq - 1);
      expect(lastResult().objects).toBeLessThan(10);
      expect(lastResult().walked).toBe(0);

      // One pack to read: no index to merge, and no history to read
      expect(used(before).gets).toBe(0);
      expect(reading(used(before))).toBeLessThanOrEqual(2);
      expectMirror(client);
    });

    it("fetches after several pushes, and pulls", async function () {
      const client = await clone("client");

      for (let i = 0; i < 3; i++) {
        addCommit();
        await pushWork("master");
      }

      ok(await gitIn(client, ...IDENTITY, "pull", "--no-rebase", "--no-edit"));
      expect(lastResult().packs).toBe(3);
      expect(fx.text(client, ["rev-parse", "HEAD"])).toBe(latest.refs["refs/heads/master"]);
      expectMirror(client);
    });

    it("fetches again with nothing new, and fetches a push of several commits at once", async function () {
      const client = await clone("client");
      ok(await gitIn(client, "fetch", "origin"));

      addCommit();
      addCommit();
      addCommit();
      await pushWork("master");
      ok(await gitIn(client, "fetch", "origin"));
      expectMirror(client);
    });

    it("fetches after a force push", async function () {
      const client = await clone("client");
      addCommit();
      await pushWork("master");
      ok(await gitIn(client, "fetch", "origin"));
      expectMirror(client);

      // History is rewritten: the branch goes back two commits and on from there
      fx.git(work, ["reset", "-q", "--hard", "HEAD~2"]);
      addCommit();
      addCommit();
      await pushWork("-f", "master");

      ok(await gitIn(client, "fetch", "origin"));
      expectMirror(client);

      // A client which was never at the rewritten commits, and one which was
      const fresh = await clone("fresh");
      expectMirror(fresh);
      ok(await gitIn(client, ...IDENTITY, "pull", "--no-rebase", "--no-edit"));
      expectMirror(client);
    });

    it("fetches a client which is ahead of the server", async function () {
      const client = await clone("client");
      fx.git(client, ["config", "user.name", "Client"]);
      fx.git(client, ["config", "user.email", "client@example.com"]);
      for (let i = 0; i < 3; i++) {
        fs.writeFileSync(path.join(client, "local-" + i + ".txt"), "local " + i + "\n");
        fx.git(client, ["add", "-A"]);
        fx.git(client, ["commit", "-q", "-m", "Local " + i]);
      }

      addCommit();
      await pushWork("master");

      ok(await gitIn(client, "fetch", "origin"));
      expect(lastResult().floor).toBe(latest.seq - 1);
      expectMirror(client);

      ok(await gitIn(client, ...IDENTITY, "pull", "--no-rebase", "--no-edit"));
      fx.git(client, ["fsck", "--strict", "--no-dangling"]);
    });

    it("fetches a client whose history has nothing to do with the repository's", async function () {
      const stranger = path.join(dir, "stranger");
      fs.mkdirSync(stranger);
      fx.git(stranger, ["init", "-q", "-b", "main"]);
      for (let i = 0; i < 3; i++) {
        fs.writeFileSync(path.join(stranger, "file-" + i), "unrelated " + i + "\n");
        fx.git(stranger, ["add", "-A"]);
        fx.git(stranger, ["commit", "-q", "-m", "Unrelated " + i]);
      }

      ok(await gitIn(stranger, "fetch", server.url, "refs/heads/master:refs/remotes/origin/master"));
      expect(lastResult().floor).toBe(0);
      expect(lastResult().packs).toBe(latest.packs.length);
      expect(lastResult().commons).toBe(0);

      fx.git(stranger, ["fsck", "--strict", "--no-dangling"]);
      expect(fx.text(stranger, ["rev-parse", "refs/remotes/origin/master"])).toBe(latest.refs["refs/heads/master"]);
    });

    it("follows an annotated tag pushed after the clone, and a lightweight one", async function () {
      const client = await clone("client");
      expect(fx.text(client, ["tag"])).toBe("v1");

      const tip = addCommit();
      fx.git(work, ["tag", "-a", "v2", "-m", "Version 2", tip]);
      fx.git(work, ["tag", "light", tip]);
      await pushWork("master", "refs/tags/v2", "refs/tags/light");
      expect(latest.peeled[latest.refs["refs/tags/v2"]]).toBe(tip);
      expect(latest.peeled[latest.refs["refs/tags/light"]]).toBeUndefined();

      // Nothing asks for tags: git sees the "^{}" line and fetches them itself
      ok(await gitIn(client, "fetch", "origin"));
      expect(fx.text(client, ["tag"]).split("\n")).toEqual(["light", "v1", "v2"]);
      expectMirror(client);
    });

    it("sends a tag on an old commit that the client does not have", async function () {
      // A client which took the branches and none of the tags
      const client = await clone("client", "--no-tags");
      expect(fx.text(client, ["tag"])).toBe("");

      addCommit();
      await pushWork("master");

      // v1 is in the first pack, which a fetch would not send were it not asked for
      ok(await gitIn(client, "fetch", "--tags", "origin"));
      expect(fx.text(client, ["tag"])).toBe("v1");
      expectMirror(client);
    });

    it("fetches a client which has some of the tags", async function () {
      fx.git(work, ["tag", "-a", "v0", "-m", "Version 0", "master~3"]);
      await pushWork("refs/tags/v0");
      const client = await clone("client");
      expect(fx.text(client, ["tag"]).split("\n")).toEqual(["v0", "v1"]);

      addCommit();
      fx.git(work, ["tag", "-a", "v2", "-m", "Version 2"]);
      await pushWork("master", "refs/tags/v2");

      ok(await gitIn(client, "fetch", "origin"));
      expect(fx.text(client, ["tag"]).split("\n")).toEqual(["v0", "v1", "v2"]);
      expectMirror(client);
    });

  });

  describe("history that is restored", function () {
    beforeEach(() => setup());
    afterEach(teardown);

    // Push A, push B, force push back to A, clone, force push B again. The
    // second push of B is the same pack as the first, which is already listed.
    it("sends what a client needs when a force push makes an old pack reachable again", async function () {
      await pushWork("master");
      const a = fx.text(work, ["rev-parse", "HEAD"]);
      const b = addCommit();
      await pushWork("master");
      fx.git(work, ["reset", "-q", "--hard", a]);
      await pushWork("-f", "master");

      // A clone of the store would be sent every pack, B's too; this client has A and no more
      const client = await clientFromWork("client");
      expect(fx.text(client, ["rev-parse", "HEAD"])).toBe(a);

      const packs = latest.packs.length;
      fx.git(work, ["reset", "-q", "--hard", b]);
      await pushWork("-f", "master");

      // The pack is listed once, as the last, with the seq of the push that made it reachable
      expect(latest.packs.length).toBe(packs);
      expect(latest.packs[latest.packs.length - 1].seq).toBe(latest.seq);
      expect(new Set(latest.packs.map((pack) => pack.name)).size).toBe(latest.packs.length);

      ok(await gitIn(client, "fetch", "origin"));
      expect(lastResult().floor).toBe(latest.seq - 1);
      expect(lastResult().packs).toBe(1);
      expectMirror(client, { tags: false });
      ok(await gitIn(client, ...IDENTITY, "pull", "--no-rebase", "--no-edit"));
      expect(fx.text(client, ["rev-parse", "HEAD"])).toBe(b);

      // And a clone, which keeps one copy of each object
      expectMirror(await clone("fresh"));
    });

    it("lists the packs again when a push with no pack makes an unreachable commit reachable", async function () {
      await pushWork("master");
      const a = fx.text(work, ["rev-parse", "HEAD"]);
      const b = addCommit();
      await pushWork("master");
      fx.git(work, ["reset", "-q", "--hard", a]);
      await pushWork("-f", "master");
      const client = await clientFromWork("client");

      const tag = (oid, ref) => receive({ store, cache, lock: createLock(), commands: [{ old: "0".repeat(40), new: oid, ref }], pack: null });

      // A commit that master reaches needs nothing moved
      const before = (await refresh()).packs;
      expect((await tag(a, "refs/tags/at-a")).outcome).toBe("ok");
      expect((await refresh()).packs).toEqual(before);

      // One that no ref reaches may be in any pack
      expect((await tag(b, "refs/tags/at-b")).outcome).toBe("ok");
      await refresh();
      expect(latest.packs.map((pack) => pack.name)).toEqual(before.map((pack) => pack.name));
      expect(latest.packs.every((pack) => pack.seq === latest.seq)).toBe(true);

      ok(await gitIn(client, "fetch", "--tags", "origin"));
      expect(fx.text(client, ["rev-parse", "refs/tags/at-b"])).toBe(b);
      expectMirror(client);
    });
  });

  describe("a push that lands between the advertisement and the request", function () {
    beforeEach(() => setup());
    afterEach(teardown);

    it("sends everything for a want that is no longer a tip", async function () {
      await pushWork("master");
      const a = fx.text(work, ["rev-parse", "HEAD"]);
      const client = await clientFromWork("client");

      const b = addCommit();
      await pushWork("master");
      const advertised = latest;
      fx.git(work, ["reset", "-q", "--hard", a]);
      await pushWork("-f", "master");

      // The client reads refs with B on master, and by its request master is A again
      let calls = 0;
      const racing = await startServer({ store, cache, manifest: () => (calls++ === 0 ? advertised : latest) });
      try {
        ok(await gitIn(client, "fetch", racing.url, "+refs/heads/*:refs/remotes/origin/*"));
        const result = racing.results[racing.results.length - 1];
        expect(result.floor).toBe(0);
        expect(result.packs).toBe(latest.packs.length);
        fx.git(client, ["fsck", "--strict", "--no-dangling"]);
        expect(fx.text(client, ["rev-parse", "refs/remotes/origin/master"])).toBe(b);
      } finally {
        await racing.close();
      }
    });
  });

  describe("a snapshot with no refs", function () {
    beforeEach(() => setup());
    afterEach(teardown);

    // Only a tag, then the tag deleted, then master: the snapshot between has no refs
    it("is not taken to be proven by a client that has nothing in common", async function () {
      await pushWork("refs/tags/v1");
      await pushWork(":refs/tags/v1");
      expect(latest.snapshots[latest.snapshots.length - 1].refs).toEqual({});
      await pushWork("master");

      const stranger = path.join(dir, "stranger");
      fs.mkdirSync(stranger);
      fx.git(stranger, ["init", "-q", "-b", "main"]);
      fs.writeFileSync(path.join(stranger, "file"), "unrelated\n");
      fx.git(stranger, ["add", "-A"]);
      fx.git(stranger, ["commit", "-q", "-m", "Unrelated"]);

      ok(await gitIn(stranger, "fetch", server.url, "refs/heads/master:refs/remotes/origin/master"));
      expect(lastResult().floor).toBe(0);
      expect(lastResult().packs).toBe(latest.packs.length);
      fx.git(stranger, ["fsck", "--strict", "--no-dangling"]);
      expect(fx.text(stranger, ["rev-parse", "refs/remotes/origin/master"])).toBe(latest.refs["refs/heads/master"]);
    });

    it("never acknowledges nothing", async function () {
      await pushWork("refs/tags/v1");
      await pushWork(":refs/tags/v1");
      await pushWork("master");

      for (const caps of [CAPS, "multi_ack_detailed side-band-64k ofs-delta"]) {
        const out = new PassThrough();
        const written = collect(out);
        await serve({ store, cache, manifest: latest, body: request({ wants: [latest.refs["refs/heads/master"]], haves: ["e".repeat(40)], caps }), out });
        expect((await written).toString("latin1")).not.toContain("undefined");
      }
    });
  });

  describe("a client which lacks a tip that has always been in the refs", function () {
    beforeEach(async function () {
      await setup({ commits: 8 });

      // An old line of work, tagged, pushed with the first push: every snapshot has its tip
      const side = addCommit({ branchFrom: "master~4" });
      fx.git(work, ["checkout", "-q", "master"]);
      fx.git(work, ["tag", "old-work", side]);
      await pushWork("master", "refs/tags/old-work");
    });
    afterEach(teardown);

    // A client made from the repository as it is now, taking master and nothing
    // else, so it has never had the old line of work. (A clone of the store would
    // have it: a clone is sent every object, whatever refs it asked for.)
    async function clientWithoutIt(name) {
      const target = path.join(dir, name);
      ok(await runGit(["clone", "-q", "--no-tags", "--single-branch", "--branch", "master", "file://" + work, target]));
      fx.git(target, ["remote", "set-url", "origin", server.url]);
      expect(fx.text(target, ["rev-list", "--all", "--count"])).toBe("8");
      return target;
    }

    it("is sent everything, without walking the history for each commit", async function () {
      const client = await clientWithoutIt("client");

      for (let i = 0; i < 4; i++) {
        addCommit();
        await pushWork("master");
      }

      const cloning = { ...store.stats };
      await clone("other");
      const cloneRequests = reading(used(cloning));

      const before = { ...store.stats };
      ok(await gitIn(client, "fetch", "origin"));
      const result = lastResult();

      expect(result.floor).toBe(0);
      expect(result.packs).toBe(latest.packs.length);
      expect(result.walked).toBeGreaterThan(0);

      // It costs what a clone does, and a request for each history piece
      // (the history is read once). Walking back from the client's commits
      // through the big packs would cost a request or more for each commit.
      expect(used(before).gets).toBe(latest.historyPieces.length);
      expect(reading(used(before))).toBeLessThanOrEqual(cloneRequests + latest.historyPieces.length);
      expect(latest.historyPieces.length).toBe(5);
      fx.git(client, ["fsck", "--strict", "--no-dangling"]);
      expect(fx.text(client, ["rev-parse", "refs/remotes/origin/master"])).toBe(latest.refs["refs/heads/master"]);
      fx.git(client, ["cat-file", "-e", latest.refs["refs/tags/old-work"]]);
    });

    it("is sent everything when the history is too big to read", async function () {
      const client = await clientWithoutIt("client");
      addCommit();
      await pushWork("master");

      const small = await startServer({ store, cache, manifest: () => latest, historyLimit: 100 });
      try {
        ok(await gitIn(client, "fetch", small.url, "+refs/heads/*:refs/remotes/origin/*"));
        expect(small.results[small.results.length - 1].floor).toBe(0);
        expect(small.results[small.results.length - 1].packs).toBe(latest.packs.length);
        fx.git(client, ["fsck", "--strict", "--no-dangling"]);
        expect(fx.text(client, ["rev-parse", "refs/remotes/origin/master"])).toBe(latest.refs["refs/heads/master"]);
      } finally {
        await small.close();
      }
    });
  });

  describe("the cost of a fetch", function () {
    beforeEach(async function () {
      await setup();
      await pushWork("master");
      for (let i = 0; i < 3; i++) {
        addCommit();
        addCommit();
        await pushWork("master");
      }
    });
    afterEach(teardown);

    it("finds the client's place by walking ancestry when its haves do not include a tip", async function () {
      const [client] = await clientsInMiddleOfPush("client");
      addCommit();
      await pushWork("master");
      const pushes = latest.snapshots.length;

      ok(await gitIn(client.dir, "fetch", "origin"));
      const result = lastResult();

      // The client is part way through the push before the last: it has the
      // push before that, which is further back than git's first round of haves
      expect(result.walked).toBeGreaterThan(0);
      expect(result.floor).toBe(pushes - 2);
      expect(result.packs).toBe(2);
      expectMirror(client.dir, { tags: false });
    });

    it("reads one pack for a client one push behind, cold or warm", async function () {
      const clients = [];
      for (const name of ["a", "b"]) clients.push(await clone(name));

      addCommit();
      await pushWork("master");

      const counts = [];
      for (const client of clients) {
        const before = { ...store.stats };
        ok(await gitIn(client, "fetch", "origin"));
        counts.push(reading(used(before)));
        expect(used(before).gets).toBe(0);
        expect(lastResult().packs).toBe(1);
      }

      expect(counts[0]).toBeLessThanOrEqual(2);
      expect(counts[1]).toBeLessThanOrEqual(counts[0]);
    });

    it("reads the history once when it has to walk, and not again when it is warm", async function () {
      const clients = await clientsInMiddleOfPush("a", "b");
      addCommit();
      await pushWork("master");

      const counts = [];
      for (const client of clients) {
        const before = { ...store.stats };
        ok(await gitIn(client.dir, "fetch", "origin"));
        counts.push({ gets: used(before).gets, total: reading(used(before)) });
        expect(lastResult().walked).toBeGreaterThan(0);
        expectMirror(client.dir, { tags: false });
      }

      // Cold: a request for each history piece. Warm: they are in the cache,
      // when the cache can hold them (zlib.crc32 is in Node 22.2 and later).
      expect(counts[0].gets).toBe(latest.historyPieces.length);
      if (typeof zlib.crc32 === "function") {
        expect(counts[1].gets).toBe(0);
        expect(counts[1].total).toBeLessThan(counts[0].total);
      } else {
        expect(counts[1].gets).toBeLessThanOrEqual(counts[0].gets);
      }
    });

    it("stops the walk at the limit it is given, and a shorter walk only proves less", async function () {
      const [client] = await clientsInMiddleOfPush("a");
      addCommit();
      await pushWork("master");

      const haves = [client.first];
      const wide = await negotiate({ store, cache, manifest: latest, haves });
      const narrow = await negotiate({ store, cache, manifest: latest, haves, maxWalk: 1 });

      expect(wide.floor).toBeGreaterThan(0);
      expect(wide.walked).toBeGreaterThan(1);
      expect(narrow.walked).toBe(1);
      expect(narrow.floor).toBe(0);
      expect(narrow.ready).toBe(false);
    });
  });

  describe("the negotiation", function () {
    let commits;

    // Three pushes after the first, so there are four snapshots
    beforeAll(async function () {
      await setup();
      await pushWork("master", "refs/tags/v1");
      commits = [fx.text(work, ["rev-parse", "HEAD"])];
      for (let i = 0; i < 3; i++) {
        commits.push(addCommit());
        await pushWork("master");
      }
    });
    afterAll(teardown);

    async function ask(options) {
      const out = new PassThrough();
      const written = collect(out);
      const result = await serve({ store, cache, manifest: latest, body: request({ wants: [commits[3]], ...options }), out });
      return { result, ...answerOf(await written) };
    }

    const unknown = "e".repeat(40);

    it("is ready at once when a have is the tip of a snapshot, and sends the pack with no-done", async function () {
      const { result, lines, pack } = await ask({ haves: [unknown, commits[2]] });

      expect(lines).toEqual(["ACK " + commits[2] + " common", "ACK " + commits[2] + " ready", "NAK", "ACK " + commits[2]]);
      expect(pack).toBe(true);
      expect(result.floor).toBe(3);
      expect(result.packs).toBe(1);
    });

    it("answers a round without a pack when the client does not use no-done, and the done that follows sends it", async function () {
      const caps = "multi_ack_detailed side-band-64k ofs-delta";
      const round = await ask({ haves: [commits[2]], caps });
      expect(round.lines).toEqual(["ACK " + commits[2] + " common", "ACK " + commits[2] + " ready", "NAK"]);
      expect(round.pack).toBe(false);
      expect(round.result.negotiated).toBe(true);

      // The next request carries the haves the client was told are common
      const last = await ask({ haves: [commits[2]], caps, done: true });
      expect(last.lines).toEqual(["ACK " + commits[2] + " common", "ACK " + commits[2]]);
      expect(last.pack).toBe(true);
      expect(last.result.packs).toBe(1);
    });

    it("sends NAK for haves it does not know, and sends everything when the client is done", async function () {
      const round = await ask({ haves: [unknown, "d".repeat(40)] });
      expect(round.lines).toEqual(["NAK"]);
      expect(round.pack).toBe(false);

      const last = await ask({ haves: [unknown], done: true });
      expect(last.lines).toEqual(["NAK"]);
      expect(last.pack).toBe(true);
      expect(last.result.floor).toBe(0);
      expect(last.result.packs).toBe(latest.packs.length);
    });

    it("acknowledges commits it has that are not tips, and is ready when they prove a snapshot", async function () {
      const first = commits[0];
      const { lines, result } = await ask({ haves: [unknown, first], caps: "multi_ack_detailed side-band-64k ofs-delta" });

      // The first push's tip is a tip of the first snapshot; the client has all of it
      expect(lines).toEqual(["ACK " + first + " common", "ACK " + first + " ready", "NAK"]);
      expect(result.floor).toBe(1);
    });

    it("sends only NAK to a client which did not ask for multi_ack_detailed, and still sends less on done", async function () {
      const caps = "side-band-64k ofs-delta";
      const round = await ask({ haves: [commits[2]], caps });
      expect(round.lines).toEqual(["NAK"]);

      const last = await ask({ haves: [commits[2]], caps, done: true });
      expect(last.lines).toEqual(["NAK"]);
      expect(last.pack).toBe(true);
      expect(last.result.floor).toBe(3);
    });

    it("refuses a want which is not a tip of any ref, even with haves", async function () {
      const out = new PassThrough();
      const written = collect(out);
      const result = await serve({ store, cache, manifest: latest, body: request({ wants: [commits[0].replace(/./, "0")], haves: [commits[2]] }), out });
      expect(result.refused).toMatch(/not our ref/);
      expect((await written).toString()).toMatch(/ERR /);
    });

    it("sends a pack of no objects to a client that has every snapshot", async function () {
      const out = new PassThrough();
      const written = collect(out);
      const result = await serve({ store, cache, manifest: latest, body: request({ wants: [commits[3]], haves: [commits[3]], done: true }), out });
      const bytes = await written;

      expect(result.packs).toBe(0);
      expect(result.objects).toBe(0);
      // A header saying version 2 and no objects, and the 20 byte checksum
      expect(result.bytes).toBe(32);
      expect(bytes.toString("latin1")).toContain("\x01PACK\x00\x00\x00\x02\x00\x00\x00\x00");
    });

    it("lets a client which has nothing send a want and done as a clone does", async function () {
      const { result, lines, pack } = await ask({ done: true });
      expect(lines).toEqual(["NAK"]);
      expect(pack).toBe(true);
      expect(result.floor).toBe(0);
    });

    it("sends more rather than less when it cannot tell a tag is in the packs it chose", async function () {
      // The client has the commits of the last push's snapshot but asks for the
      // tag, which is in the first pack: so everything goes
      const tag = latest.refs["refs/tags/v1"];
      const { result } = await ask({ haves: [commits[2]], caps: CAPS });
      expect(result.packs).toBe(1);

      const out = new PassThrough();
      const written = collect(out);
      const sent = await serve({ store, cache, manifest: latest, body: request({ wants: [commits[3], tag], haves: [commits[2]] }), out });
      await written;
      expect(sent.floor).toBe(0);
      expect(sent.packs).toBe(latest.packs.length);
    });
  });

  describe("a manifest from before tags were peeled", function () {
    beforeEach(() => setup());
    afterEach(teardown);

    // The repository as an older receive would have left it
    const older = () => delete latest.peeled;

    it("fetches a branch, reading the history to tell that what is asked for is not a tag", async function () {
      await pushWork("master");
      const client = await clone("client");
      addCommit();
      await pushWork("master");
      older();
      expect(manifest.parse(manifest.serialize(latest)).peeled).toBeUndefined();

      const before = { ...store.stats };
      ok(await gitIn(client, "fetch", "origin"));
      expect(lastResult().floor).toBe(latest.seq - 1);
      expect(lastResult().packs).toBe(1);
      expect(used(before).gets).toBe(latest.historyPieces.length);
      expectMirror(client);
    });

    it("sends everything for a repository with an annotated tag, whose target it does not know", async function () {
      await pushWork("master", "refs/tags/v1");
      const client = await clone("client", "--no-tags");
      addCommit();
      await pushWork("master");
      older();
      expect(advertise(latest).toString("latin1")).not.toContain("^{}");

      ok(await gitIn(client, "fetch", "--tags", "origin"));
      expect(lastResult().floor).toBe(0);
      expect(fx.text(client, ["tag"])).toBe("v1");
      expectMirror(client);
    });
  });
});
