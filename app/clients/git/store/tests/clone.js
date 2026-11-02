// Streams clones out of packs in a memory store and checks them with real git:
// `git clone` with transfer.fsckObjects, then `git fsck --strict`, and every
// object compared with the origin's.
const crypto = require("crypto");
const fs = require("fs");
const { PassThrough, Writable } = require("stream");
const fx = require("./helpers/fixture");
const timeout = require("./helpers/timeout");
const faults = require("./helpers/faults");
const { startServer, runGit, manifestOf, collect } = require("./helpers/upload-server");
const createMemoryStore = require("../objectStore/memory");
const { clone, serve, createLimiter, plan } = require("../clone");
const { parseHeader } = require("../pack");
const { ClientGoneError, BusyError } = require("../errors");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function objectIds(dir) {
  return fx
    .text(dir, ["cat-file", "--batch-all-objects", "--batch-check=%(objectname)"])
    .split("\n")
    .filter(Boolean)
    .sort();
}

describe("git store clone", function () {
  timeout(120 * 1000);

  let workDir;
  let fixture;
  let origin; // every object ID in the origin, sorted
  let counter = 0;

  beforeAll(function () {
    workDir = fx.tempDir();
    fixture = fx.buildFixture(workDir + "/repo");
    origin = objectIds(fixture.dir);
  });

  afterAll(function () {
    fx.remove(workDir);
  });

  const tags = () => ({ v1: fixture.tag });

  // Uploads packs and returns the store and a manifest which lists them
  async function repository(packs, { wrap = (store) => store } = {}) {
    const memory = createMemoryStore();
    const entries = [];
    for (const pack of packs) entries.push(await fx.upload(memory, pack, pack.pack.readUInt32BE(8)));
    return { memory, store: wrap(memory), manifest: manifestOf(entries, fixture.head, tags()), entries };
  }

  // The packs are listed oldest first: one pack with everything
  function onePack() {
    fx.repackAll(fixture.dir);
    return fx.readPacks(fixture.dir);
  }

  // Two complete packs which share objects: the first has commits 1 to 20, the
  // second what is reachable from the tip and not from commit 12. Objects of
  // commits 13 to 20 are in both, spread through the first pack, so skipping
  // them moves what follows (the 3 MB blob is only in the first pack).
  function overlapping() {
    const first = fx.indexPack(fx.packRevs(fixture.dir, [fixture.commits[19]]));
    const second = fx.indexPack(fx.packRevs(fixture.dir, [fixture.head, fixture.tag], [fixture.commits[11]]));
    return [first, second];
  }

  // Three packs as pushes make them: each is a thin pack completed by
  // `index-pack --fix-thin`, which appends the bases it needed, copies of
  // objects an older pack already holds
  function pushed() {
    const first = fx.indexPack(fx.packRevs(fixture.dir, [fixture.commits[9]]));
    const second = fx.fixThin(fx.packRevs(fixture.dir, [fixture.commits[19]], [fixture.commits[9]], { thin: true }), [first]);
    const third = fx.fixThin(fx.packRevs(fixture.dir, [fixture.head, fixture.tag], [fixture.commits[19]], { thin: true }), [first, second]);
    return [first, second, third];
  }

  // One pack, and a second which holds two of its objects whole, chosen to
  // make the first pack's entries change when those are skipped:
  // - `base`, which an OFS_DELTA entry of the first pack is a delta against, so
  //   that entry has to name its base by ID once the copy is gone;
  // - `between`, an entry which sits between another OFS_DELTA entry and its
  //   base, so that entry's distance has to shrink.
  function forcedChanges() {
    fx.repackAll(fixture.dir);
    const [first] = fx.readPacks(fixture.dir);
    const entries = fx.listEntries(first).map((entry) => ({ ...entry, base: baseOffsetOf(first.pack, entry.offset) }));

    const deltas = entries.filter((e) => e.base !== null);
    const base = entries.find((e) => e.offset === deltas[0].base);
    const between = entries.find((e) => e.base === null && e !== base && deltas.some((d) => d.base < e.offset && e.offset < d.offset));
    if (!base || !between) throw new Error("The fixture has no delta to rewrite");

    const input = [base.oid, between.oid].join("\n") + "\n";
    const second = fx.indexPack(fx.git(fixture.dir, ["pack-objects", "--stdout", "-q"], input));
    return [first, second];
  }

  // The offset of the base of the OFS_DELTA entry at `offset`, or null
  function baseOffsetOf(pack, offset) {
    const header = parseHeader(pack.subarray(offset, offset + 64), offset);
    return header.baseOffset === undefined ? null : header.baseOffset;
  }

  function overlap(a, b) {
    const ids = new Set(fx.listEntries(a).map((e) => e.oid));
    return fx.listEntries(b).filter((e) => ids.has(e.oid)).length;
  }

  // Runs clone() into memory. Returns { pack, result }; the pack is whatever
  // was written, complete or not.
  async function direct(repo, options = {}) {
    const out = new PassThrough();
    const chunks = [];
    out.on("data", (chunk) => chunks.push(chunk));
    out.on("error", () => {});
    const done = new Promise((resolve) => out.on("close", resolve));
    let result;
    let error;
    try {
      result = await clone({ store: repo.store, manifest: repo.manifest, out, ...options });
    } catch (err) {
      error = err;
      // a failure before anything was written leaves the stream to the host
      out.destroy();
    }
    await done;
    return { result, error, pack: Buffer.concat(chunks) };
  }

  // Checks the pack git-wise: it indexes, holds exactly the origin's objects
  // and the count in its header
  function expectCompletePack(pack, result) {
    expect(pack.readUInt32BE(8)).toBe(result.objects);
    const indexed = fx.indexPack(pack);
    const ids = fx
      .listEntries(indexed)
      .map((e) => e.oid)
      .sort();
    expect(ids.length).toBe(result.objects);
    expect(ids).toEqual(origin);
  }

  async function cloneWithGit(repo, options = {}) {
    const server = await startServer({ store: repo.store, manifest: () => repo.manifest, ...options });
    const dir = workDir + "/clone-" + ++counter;

    try {
      const cloned = await runGit(["-c", "transfer.fsckObjects=true", "clone", server.url, dir]);
      return { server, dir, cloned };
    } finally {
      await server.close();
    }
  }

  async function expectGoodClone(repo, options) {
    const { server, dir, cloned } = await cloneWithGit(repo, options);

    expect(server.errors).toEqual([]);
    expect(cloned.stderr).not.toMatch(/error|fatal/i);
    expect(cloned.code).toBe(0);
    expect((await runGit(["fsck", "--strict"], { cwd: dir })).code).toBe(0);
    expect((await runGit(["rev-parse", "HEAD", "v1"], { cwd: dir })).stdout.trim().split("\n")).toEqual([fixture.head, fixture.tag]);
    expect(objectIds(dir)).toEqual(origin);
    return server.results[0];
  }

  describe("one pack", function () {
    let repo;

    beforeAll(async function () {
      repo = await repository(onePack());
    });

    it("is cloned by git, which fscks the objects as they arrive and afterwards", async function () {
      const result = await expectGoodClone(repo);
      expect(result.skipped).toBe(0);
      expect(result.objects).toBe(origin.length);
    });

    it("is cloned by git in a small chunk size, so the copy takes many reads", async function () {
      await expectGoodClone(repo, { chunkSize: 16 * 1024 });
    });

    it("writes a pack git indexes, with the header's count and a SHA-1 trailer", async function () {
      const { pack, result } = await direct(repo);
      expectCompletePack(pack, result);
      expect(crypto.createHash("sha1").update(pack.subarray(0, pack.length - 20)).digest().equals(pack.subarray(pack.length - 20))).toBe(true);
    });

    it("copies the entries as they are stored, byte for byte", async function () {
      const { pack } = await direct(repo);
      const stored = fx.readPacks(fixture.dir)[0].pack;
      expect(pack.subarray(12, pack.length - 20).equals(stored.subarray(12, stored.length - 20))).toBe(true);
    });

    it("reads each chunk once, and neither the index nor the object's size", async function () {
      const chunkSize = 256 * 1024;
      const memory = createMemoryStore();
      const pack = fx.readPacks(fixture.dir)[0];
      const entry = await fx.upload(memory, pack, pack.pack.readUInt32BE(8));

      const { result } = await direct({ store: memory, manifest: manifestOf([entry], fixture.head, tags()) }, { chunkSize });
      expect(result.objects).toBe(origin.length);
      expect(memory.stats.reads).toBe(Math.ceil(entry.size / chunkSize));
      expect(memory.stats.heads + memory.stats.gets + memory.stats.lists).toBe(0);
    });

    it("never writes a piece bigger than a chunk, though one object is 3 MB", async function () {
      const sizes = [];
      const out = new Writable({
        write(chunk, encoding, callback) {
          sizes.push(chunk.length);
          callback();
        },
      });
      const result = await clone({ store: repo.store, manifest: repo.manifest, out, chunkSize: 64 * 1024 });

      expect(result.objects).toBe(origin.length);
      expect(Math.max(...sizes)).toBeLessThanOrEqual(64 * 1024);
      expect(sizes.reduce((a, b) => a + b, 0)).toBe(result.bytes);
    });
  });

  describe("several packs which share objects", function () {
    it("has packs which share objects, for these specs to skip", function () {
      const [first, second] = overlapping();
      expect(overlap(first, second)).toBeGreaterThan(50);

      const [a, b, c] = pushed();
      expect(overlap(a, b) + overlap(b, c) + overlap(a, c)).toBeGreaterThan(0);
    });

    it("sends each object once from overlapping packs", async function () {
      const repo = await repository(overlapping());
      const { pack, result } = await direct(repo, { chunkSize: 64 * 1024 });

      expect(result.skipped).toBeGreaterThan(50);
      expectCompletePack(pack, result);
    });

    it("shortens the distance of an OFS_DELTA which a skipped entry sat inside", async function () {
      const repo = await repository(forcedChanges());
      const { pack, result } = await direct(repo, { chunkSize: 64 * 1024 });

      expect(result.skipped).toBe(2);
      expect(result.rewritten).toBeGreaterThan(0);
      expectCompletePack(pack, result);
    });

    it("turns a delta whose base was a skipped copy into one that names it", async function () {
      const repo = await repository(forcedChanges());
      const { pack, result } = await direct(repo);

      expect(result.toRef).toBeGreaterThan(0);
      expectCompletePack(pack, result);
    });

    it("rewrites entries when reads are so small that headers and streams straddle them", async function () {
      const repo = await repository(forcedChanges());
      const { pack, result } = await direct(repo, { chunkSize: 1000 });

      expect(result.rewritten + result.toRef).toBeGreaterThan(0);
      expectCompletePack(pack, result);
    });

    it("finds duplicates in a pack whose index keeps its offsets in the table of 8-byte offsets", async function () {
      const [first, second] = overlapping();
      const wide = { ...first, idx: fx.buildIdx(fx.listEntries(first), first.pack, { largeFrom: 0 }) };
      const repo = await repository([wide, second]);
      const { pack, result } = await direct(repo, { chunkSize: 64 * 1024 });

      expect(result.skipped).toBeGreaterThan(50);
      expectCompletePack(pack, result);
    });

    it("is cloned by git when entries are rewritten", async function () {
      const result = await expectGoodClone(await repository(forcedChanges()));
      expect(result.rewritten + result.toRef).toBeGreaterThan(0);
    });

    it("is cloned by git from overlapping packs", async function () {
      const result = await expectGoodClone(await repository(overlapping()));
      expect(result.skipped).toBeGreaterThan(50);
    });

    it("is cloned by git from packs which pushes made, with their appended bases", async function () {
      const result = await expectGoodClone(await repository(pushed()));
      expect(result.skipped).toBeGreaterThan(0);
      expect(result.objects).toBe(origin.length);
    });

    it("keeps the newest copy of an object, and skips the others", async function () {
      const run = { signal: new AbortController().signal, chunkSize: 1024 * 1024 };

      const two = await repository(overlapping());
      const skips = (await plan({ ...run, store: two.store }, two.manifest.packs)).skips;
      expect(skips[0].count).toBeGreaterThan(50);
      expect(skips[1].count).toBe(0);

      const three = await repository(pushed());
      const more = (await plan({ ...run, store: three.store }, three.manifest.packs)).skips;
      expect(more[2].count).toBe(0);
      expect(more[0].count + more[1].count).toBeGreaterThan(0);
    });

    it("reads each index twice at most and each chunk once", async function () {
      const packs = overlapping();
      const repo = await repository(packs);
      const chunkSize = 256 * 1024;
      const before = repo.memory.stats.reads;

      await direct(repo, { chunkSize });

      const chunks = repo.entries.reduce((n, e) => n + Math.ceil(e.size / chunkSize), 0);
      expect(repo.memory.stats.reads - before).toBeLessThanOrEqual(chunks + 2 * packs.length);
      expect(repo.memory.stats.heads).toBe(0);
    });

    it("merges the indexes a few IDs at a time when there are many packs", async function () {
      // The same pack listed under many names: every object is a duplicate,
      // and the merge has to read the indexes in slices
      const [first] = overlapping();
      const memory = createMemoryStore();
      const entries = [];
      for (let i = 0; i < 40; i++) {
        const name = "pack-" + String(i).padStart(40, "0");
        entries.push(await fx.upload(memory, { ...first, name }, first.pack.readUInt32BE(8)));
      }

      const run = { store: memory, signal: new AbortController().signal, chunkSize: 1024 * 1024, mergeBudget: 1 };
      const thePlan = await plan(run, entries);
      const each = first.pack.readUInt32BE(8);
      expect(thePlan.total).toBe(each);
      expect(thePlan.skipped).toBe(each * 39);
      expect(thePlan.skips[39].count).toBe(0);
    });
  });

  describe("an empty repository", function () {
    it("is cloned by git as an empty repository", async function () {
      const repo = { store: createMemoryStore(), manifest: manifestOf([], null) };
      const { server, dir, cloned } = await cloneWithGit(repo);

      expect(cloned.code).toBe(0);
      expect(cloned.stderr).toMatch(/empty repository/);
      expect(server.results).toEqual([]);
      expect((await runGit(["rev-parse", "--verify", "HEAD"], { cwd: dir })).code).not.toBe(0);
    });
  });

  describe("failures", function () {
    // The pack is written in the same few chunks, so a fault at the Nth read
    // of it lands in the middle of the clone
    const chunkSize = 64 * 1024;

    async function faulty(packs, fault, options = {}) {
      const repo = await repository(packs, { wrap: faults });
      repo.store.inject("read", fault);
      return { repo, ...(await direct(repo, { chunkSize, ...options })) };
    }

    function expectNotAPack(bytes) {
      // either nothing was sent, or what was sent lacks a checksum which fits
      if (!bytes.length) return;
      const checksum = crypto.createHash("sha1").update(bytes.subarray(0, bytes.length - 20)).digest();
      expect(checksum.equals(bytes.subarray(bytes.length - 20))).toBe(false);
    }

    it("fails when a read comes back short in the middle of a copy", async function () {
      const { error, pack } = await faulty(onePack(), { key: /\.pack$/, skip: 3, truncate: 1000 });
      expect(error && error.code).toBe("CORRUPT");
      expect(pack.length).toBeGreaterThan(0);
      expectNotAPack(pack);
    });

    it("fails when a read comes back short in the middle of a walk", async function () {
      const { error, pack } = await faulty(overlapping(), { key: /\.pack$/, skip: 4, truncate: 1000 });
      expect(error && error.code).toBe("CORRUPT");
      expectNotAPack(pack);
    });

    it("fails when a read errors in the middle", async function () {
      const { error, pack } = await faulty(overlapping(), { key: /\.pack$/, skip: 2, before: new Error("ECONNRESET") });
      expect(error && error.message).toBe("ECONNRESET");
      expectNotAPack(pack);
    });

    it("fails before writing anything when an index cannot be read", async function () {
      const { error, pack } = await faulty(overlapping(), { key: /\.idx$/, before: new Error("ECONNRESET") });
      expect(error && error.message).toBe("ECONNRESET");
      expect(pack.length).toBe(0);
    });

    it("fails before writing anything when an index is short", async function () {
      const { error, pack } = await faulty(overlapping(), { key: /\.idx$/, truncate: 500 });
      expect(error && error.code).toBe("CORRUPT");
      expect(pack.length).toBe(0);
    });

    it("fails when a pack is not the size the manifest says", async function () {
      const repo = await repository(overlapping());
      repo.manifest.packs[0].size += 100;
      const { error, pack } = await direct(repo);

      expect(error && error.code).toBe("CORRUPT");
      expectNotAPack(pack);
    });

    it("fails when a pack does not hold the objects the manifest says", async function () {
      const repo = await repository(onePack());
      repo.manifest.packs[0].objects += 1;
      const { error, pack } = await direct(repo);

      expect(error && error.code).toBe("CORRUPT");
      expectNotAPack(pack);
    });

    it("fails the git client, which keeps nothing, when a read is cut short mid-clone", async function () {
      const repo = await repository(onePack(), { wrap: faults });
      repo.store.inject("read", { key: /\.pack$/, skip: 40, truncate: 1000 });
      const { server, dir, cloned } = await cloneWithGit(repo, { chunkSize: 16 * 1024 });

      expect(server.errors.length).toBe(1);
      expect(cloned.code).not.toBe(0);
      expect(cloned.stderr).toMatch(/remote|early EOF|fatal/);
      expect(fs.existsSync(dir)).toBe(false);
    });

    it("answers 500 when it fails before it has written anything", async function () {
      const repo = await repository(overlapping(), { wrap: faults });
      repo.store.inject("read", { key: /\.idx$/, before: new Error("ECONNRESET") });
      const { server, cloned } = await cloneWithGit(repo);

      expect(cloned.code).not.toBe(0);
      expect(cloned.stderr).toMatch(/500/);
      expect(server.errors.length).toBe(1);
    });
  });

  describe("a client which goes away", function () {
    // A Writable which takes `allowed` bytes and then is destroyed, as a
    // dropped connection is
    function dropping(allowed) {
      let seen = 0;
      return new Writable({
        highWaterMark: 1,
        write(chunk, encoding, callback) {
          seen += chunk.length;
          callback();
          if (seen >= allowed) this.destroy();
        },
      });
    }

    it("stops the reading", async function () {
      const chunkSize = 16 * 1024;
      const repo = await repository(onePack(), { wrap: faults });
      repo.store.inject("read", { key: /\.pack$/, delay: 5, times: 10000 });

      const whole = await direct(repo, { chunkSize });
      const total = repo.store.calls.length;
      expect(whole.result.objects).toBe(origin.length);

      const before = repo.store.calls.length;
      let error;
      try {
        await clone({ store: repo.store, manifest: repo.manifest, out: dropping(100 * 1024), chunkSize });
      } catch (err) {
        error = err;
      }
      const used = repo.store.calls.length - before;
      expect(error instanceof ClientGoneError).toBe(true);
      expect(used).toBeLessThan(total / 4);

      await sleep(100);
      expect(repo.store.calls.length - before).toBe(used);
    });

    it("stops the walk of a pack too", async function () {
      const chunkSize = 16 * 1024;
      const repo = await repository(overlapping(), { wrap: faults });
      const before = repo.store.calls.length;
      let error;
      try {
        await clone({ store: repo.store, manifest: repo.manifest, out: dropping(100 * 1024), chunkSize });
      } catch (err) {
        error = err;
      }
      expect(error instanceof ClientGoneError).toBe(true);

      const used = repo.store.calls.length - before;
      await sleep(100);
      expect(repo.store.calls.length - before).toBe(used);
    });
  });

  describe("backpressure", function () {
    it("reads no further ahead than a few chunks while the client is not taking data", async function () {
      const chunkSize = 16 * 1024;
      const repo = await repository(onePack());
      let release;
      const blocked = new Promise((resolve) => (release = resolve));
      let received = 0;
      const out = new Writable({
        highWaterMark: 1,
        write(chunk, encoding, callback) {
          received += chunk.length;
          blocked.then(callback);
        },
      });

      const running = clone({ store: repo.store, manifest: repo.manifest, out, chunkSize });
      await sleep(300);

      const pack = repo.entries[0];
      expect(repo.memory.stats.reads).toBeLessThan(12);
      expect(repo.memory.stats.reads).toBeLessThan(Math.ceil(pack.size / chunkSize) / 4);

      release();
      const result = await running;
      expect(result.objects).toBe(origin.length);
      expect(received).toBe(result.bytes);
    });
  });

  describe("a plan which takes a while", function () {
    const pkt = (text) => (text.length + 4).toString(16).padStart(4, "0") + text;
    const request = (caps) => Buffer.from(pkt("want " + fixture.head + " " + caps + "\n") + "0000" + pkt("done\n"));

    // Index reads are held for 600 ms, and a client is told after 100
    async function held(options = {}) {
      const repo = await repository(overlapping(), { wrap: faults });
      repo.store.inject("read", { key: /\.idx$/, delay: 600, times: 100, ...options });
      return repo;
    }

    async function asked(repo, caps, extra = {}) {
      const out = new PassThrough();
      const written = collect(out);
      const result = await serve({ store: repo.store, manifest: repo.manifest, body: request(caps), out, keepaliveAfter: 100, ...extra });
      return { result, bytes: await written };
    }

    it("sends keepalives and a line of progress, then the pack", async function () {
      const { bytes } = await asked(await held(), "side-band-64k ofs-delta");
      const text = bytes.toString("latin1");

      expect(text.startsWith("0008NAK\n")).toBe(true);
      expect(text).toContain("\x02Preparing your repository...");
      expect(text.split("0005\x01").length).toBeGreaterThan(1);
    });

    it("sends no progress line to a client which asked for none, but still keepalives", async function () {
      const { bytes } = await asked(await held(), "side-band-64k ofs-delta no-progress");
      const text = bytes.toString("latin1");

      expect(text).not.toContain("Preparing");
      expect(text.split("0005\x01").length).toBeGreaterThan(1);
    });

    it("sends nothing extra when the plan is quick", async function () {
      const repo = await repository(overlapping());
      const { bytes } = await asked(repo, "side-band-64k ofs-delta", { keepaliveAfter: 60000 });
      expect(bytes.toString("latin1")).not.toContain("Preparing");
      expect(bytes.subarray(0, 8).toString()).toBe("0008NAK\n");
    });

    it("is cloned by git, which accepts the keepalives, and fscks", async function () {
      const repo = await held();
      const { server, dir, cloned } = await cloneWithGit(repo, { keepaliveAfter: 100 });

      expect(server.errors).toEqual([]);
      expect(cloned.code).toBe(0);
      expect((await runGit(["fsck", "--strict"], { cwd: dir })).code).toBe(0);
      expect(objectIds(dir)).toEqual(origin);
    });

    it("fails the git client, which keeps nothing, when the plan then fails", async function () {
      const repo = await held({ before: new Error("ECONNRESET") });
      const { server, dir, cloned } = await cloneWithGit(repo, { keepaliveAfter: 100 });

      expect(server.errors.length).toBe(1);
      expect(cloned.code).not.toBe(0);
      expect(fs.existsSync(dir)).toBe(false);
    });

    it("does not plan for a client which left while it waited its turn", async function () {
      const limiter = createLimiter({ max: 1, maxWaiting: 1 });
      const holder = await limiter.acquire();
      const repo = await repository(overlapping(), { wrap: faults });
      const out = new PassThrough();

      const waiting = clone({ store: repo.store, manifest: repo.manifest, out, limiter }).catch((err) => err);
      await sleep(10);
      out.destroy();
      await sleep(10);
      holder();

      expect((await waiting) instanceof ClientGoneError).toBe(true);
      expect(repo.store.calls.length).toBe(0);
      expect(limiter.stats()).toEqual({ active: 0, waiting: 0 });
    });
  });

  describe("the limiter", function () {
    it("runs at most `max` at once, queues up to `maxWaiting`, and refuses the rest", async function () {
      const limiter = createLimiter({ max: 2, maxWaiting: 1 });
      const first = await limiter.acquire();
      const second = await limiter.acquire();
      expect(limiter.stats()).toEqual({ active: 2, waiting: 0 });

      let third = null;
      const waiting = limiter.acquire().then((release) => (third = release));
      await sleep(10);
      expect(third).toBe(null);
      expect(limiter.stats()).toEqual({ active: 2, waiting: 1 });

      let refused;
      try {
        await limiter.acquire();
      } catch (err) {
        refused = err;
      }
      expect(refused instanceof BusyError).toBe(true);
      expect(refused.code).toBe("BUSY");

      first();
      first();
      await waiting;
      expect(third).not.toBe(null);
      expect(limiter.stats()).toEqual({ active: 2, waiting: 0 });

      second();
      third();
      expect(limiter.stats()).toEqual({ active: 0, waiting: 0 });
    });

    it("holds a place for the length of a clone", async function () {
      const limiter = createLimiter({ max: 1, maxWaiting: 0 });
      const repo = await repository(onePack(), { wrap: faults });
      repo.store.inject("read", { key: /\.pack$/, delay: 50 });

      const running = direct(repo, { limiter, chunkSize: 1024 * 1024 });
      await sleep(10);
      expect(limiter.stats().active).toBe(1);

      const refused = await direct(repo, { limiter });
      expect(refused.error instanceof BusyError).toBe(true);
      expect(refused.pack.length).toBe(0);

      expect((await running).result.objects).toBe(origin.length);
      expect(limiter.stats().active).toBe(0);
    });

    it("gives the place back after a failure", async function () {
      const limiter = createLimiter({ max: 1, maxWaiting: 0 });
      const repo = await repository(onePack(), { wrap: faults });
      repo.store.inject("read", { key: /\.pack$/, skip: 1, before: new Error("ECONNRESET") });

      const failed = await direct(repo, { limiter, chunkSize: 16 * 1024 });
      expect(failed.error.message).toBe("ECONNRESET");
      expect(limiter.stats().active).toBe(0);
    });

    it("answers 503 to a clone it has no place for", async function () {
      const limiter = createLimiter({ max: 1, maxWaiting: 0 });
      const held = await limiter.acquire();
      const repo = await repository(onePack());
      const { server, cloned } = await cloneWithGit(repo, { limiter });

      expect(server.errors[0] instanceof BusyError).toBe(true);
      expect(cloned.code).not.toBe(0);
      expect(cloned.stderr).toMatch(/503/);
      held();
    });
  });

  describe("what a client may ask for", function () {
    const caps = "side-band-64k ofs-delta agent=test";
    const want = (oid, capabilities) => Buffer.from(pkt("want " + oid + (capabilities ? " " + capabilities : "") + "\n"));

    function pkt(text) {
      return (text.length + 4).toString(16).padStart(4, "0") + text;
    }

    async function ask(repo, body) {
      const out = new PassThrough();
      const written = collect(out);
      const result = await serve({ store: repo.store, manifest: repo.manifest, body, out });
      return { result, bytes: await written };
    }

    let repo;

    beforeAll(async function () {
      repo = await repository(onePack());
    });

    it("answers a probe, which asks for nothing, with nothing", async function () {
      const { result, bytes } = await ask(repo, Buffer.from("0000"));
      expect(result.empty).toBe(true);
      expect(bytes.length).toBe(0);
    });

    for (const [name, lines, message] of [
      ["a shallow clone", [pkt("deepen 1\n")], /Shallow/],
      ["shallow lines", [pkt("shallow " + "a".repeat(40) + "\n")], /Shallow/],
      ["a filter", [pkt("filter blob:none\n")], /filters/],
      ["a fetch with have lines", [pkt("have " + "a".repeat(40) + "\n")], /existing clone/],
    ]) {
      it("refuses " + name + " with an error packet, and sends no pack", async function () {
        const body = Buffer.concat([want(fixture.head, caps), ...lines.map((l) => Buffer.from(l)), Buffer.from("0000" + pkt("done\n"))]);
        const { result, bytes } = await ask(repo, body);

        expect(result.refused).toMatch(message);
        expect(bytes.toString()).toMatch(/^[0-9a-f]{4}ERR /);
        expect(bytes.includes("PACK")).toBe(false);
      });
    }

    it("refuses an object which is not a ref's tip", async function () {
      const body = Buffer.concat([want("a".repeat(40), caps), Buffer.from("0000" + pkt("done\n"))]);
      const { result, bytes } = await ask(repo, body);

      expect(result.refused).toMatch(/not our ref/);
      expect(bytes.toString()).toMatch(/ERR upload-pack: not our ref/);
    });

    it("refuses a client without ofs-delta, whose packs it could not make", async function () {
      const body = Buffer.concat([want(fixture.head, "side-band-64k"), Buffer.from("0000" + pkt("done\n"))]);
      const { result } = await ask(repo, body);
      expect(result.refused).toMatch(/ofs-delta/);
    });

    it("rejects what is not git with a ProtocolError, before writing", async function () {
      for (const body of [Buffer.from("hello"), Buffer.from("0005"), Buffer.concat([Buffer.from(pkt("nonsense\n"))])]) {
        const out = new PassThrough();
        let error;
        try {
          await serve({ store: repo.store, manifest: repo.manifest, body, out });
        } catch (err) {
          error = err;
        }
        expect(error && error.code).toBe("PROTOCOL");
        expect(out.writableLength + out.readableLength).toBe(0);
      }
    });

    it("sends only NAK to a request which has not said done", async function () {
      const { bytes } = await ask(repo, Buffer.concat([want(fixture.head, caps), Buffer.from("0000")]));
      expect(bytes.toString()).toBe("0008NAK\n");
    });

    it("sends a pack without a side-band to a client which asked for none", async function () {
      const body = Buffer.concat([want(fixture.head, "ofs-delta"), Buffer.from("0000" + pkt("done\n"))]);
      const { bytes } = await ask(repo, body);

      expect(bytes.subarray(0, 8).toString()).toBe("0008NAK\n");
      expect(bytes.subarray(8, 12).toString()).toBe("PACK");
      expectCompletePack(bytes.subarray(8), { objects: bytes.readUInt32BE(16) });
    });

    it("sends a pack in side-band 1 packets, then a flush", async function () {
      const body = Buffer.concat([want(fixture.head, caps), Buffer.from("0000" + pkt("done\n"))]);
      const { bytes } = await ask(repo, body);

      expect(bytes.subarray(0, 8).toString()).toBe("0008NAK\n");
      const parts = [];
      let at = 8;
      while (at < bytes.length) {
        const length = parseInt(bytes.toString("latin1", at, at + 4), 16);
        if (length === 0) break;
        expect(bytes[at + 4]).toBe(1);
        parts.push(bytes.subarray(at + 5, at + length));
        at += length;
      }
      expect(at + 4).toBe(bytes.length);
      expect(Math.max(...parts.map((p) => p.length))).toBeLessThanOrEqual(65515);
      expectCompletePack(Buffer.concat(parts), { objects: Buffer.concat(parts).readUInt32BE(8) });
    });

    it("is asked by git for protocol 2 and answers in protocol 0", async function () {
      const server = await startServer({ store: repo.store, manifest: () => repo.manifest });
      try {
        const dir = workDir + "/v2-" + ++counter;
        const cloned = await runGit(["-c", "protocol.version=2", "clone", server.url, dir]);
        expect(cloned.code).toBe(0);
        expect(server.requests[0]).toContain("version=2");
      } finally {
        await server.close();
      }
    });
  });
});
