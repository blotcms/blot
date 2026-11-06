// Streams objects stored as deltas through scratch space, against packs made
// by real git in which a large file changed a little at a time, so that all but
// the newest version are deltas (some of them down a chain of several). The
// reader's in-memory cap is lowered so the files can stay modest; the cap is a
// parameter, and what it does is the same at 64 MiB.
const fs = require("fs");
const { execFile } = require("child_process");
const path = require("path");
const { Readable } = require("stream");
const fx = require("./helpers/fixture");
const timeout = require("./helpers/timeout");
const createReader = require("../reader");
const createCache = require("../cache");
const createMemoryStore = require("../objectStore/memory");
const { CorruptError, NoRoomError } = require("../errors");

const crypto = require("crypto");
const zlib = require("zlib");

const sha1 = (data) => crypto.createHash("sha1").update(data).digest("hex");
const blobId = (data) => sha1(Buffer.concat([Buffer.from("blob " + data.length + "\0"), data]));

function varint(n) {
  const out = [];
  do {
    let byte = n & 0x7f;
    n = Math.floor(n / 128);
    if (n) byte |= 0x80;
    out.push(byte);
  } while (n);
  return Buffer.from(out);
}

// A pack entry header: a type code and the inflated size
function entryHeader(type, size) {
  const out = [(type << 4) | (size & 15)];
  size = Math.floor(size / 16);
  if (size) out[0] |= 0x80;
  while (size) {
    let byte = size & 0x7f;
    size = Math.floor(size / 128);
    if (size) byte |= 0x80;
    out.push(byte);
  }
  return Buffer.from(out);
}

// A delta from the sizes and instructions
const delta = (source, target, ...ops) => Buffer.concat([varint(source), varint(target), ...ops]);
const copy = (offset, length) =>
  Buffer.from([0xff, offset & 255, (offset >> 8) & 255, (offset >> 16) & 255, (offset >> 24) & 255, length & 255, (length >> 8) & 255, (length >> 16) & 255]);
const insert = (text) => Buffer.concat([Buffer.from([text.length]), Buffer.from(text)]);

// A pack of a whole blob and one REF_DELTA entry on it, and its index, which
// names the delta by `name`
function craft(base, deltaBytes, name) {
  const header = Buffer.alloc(12);
  header.write("PACK");
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(2, 8);

  const first = Buffer.concat([entryHeader(3, base.length), zlib.deflateSync(base)]);
  const second = Buffer.concat([entryHeader(7, deltaBytes.length), Buffer.from(blobId(base), "hex"), zlib.deflateSync(deltaBytes)]);
  const body = Buffer.concat([header, first, second]);
  const pack = Buffer.concat([body, crypto.createHash("sha1").update(body).digest()]);

  const entries = [
    { oid: blobId(base), offset: 12 },
    { oid: name, offset: 12 + first.length },
  ];
  return { name: "pack-" + pack.subarray(pack.length - 20).toString("hex"), pack, idx: fx.buildIdx(entries, pack) };
}


const MiB = 1024 * 1024;
const FILE = 1.5 * MiB;
const CAP = 128 * 1024;

async function collect(iterable) {
  const chunks = [];
  for await (const chunk of iterable) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function failure(promise) {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  return null;
}

// Lines of random text, so the file does not compress and every version is
// the same size give or take what was edited
function version(n, size = FILE) {
  const hex = fx.bytes(77, size / 2).toString("hex");
  const lines = hex.match(/.{1,63}/g);
  for (let k = 0; k < 6; k++) {
    for (let v = 1; v <= n; v++) lines[(v * 7919 + k * 104729) % lines.length] = "edit " + v + " " + k + " " + "x".repeat((v * 13 + k) % 40);
  }
  return Buffer.from(lines.join("\n") + "\n");
}

describe("git store reader scratch", function () {
  timeout(60 * 1000);

  const VERSIONS = 9;
  let work;
  let repo;
  let blobs; // [{ oid, depth, size }] by version, oldest first

  beforeAll(function () {
    work = fx.tempDir();
    repo = path.join(work, "repo");
    fs.mkdirSync(repo);
    fx.git(repo, ["init", "-q", "-b", "master"]);

    for (let n = 0; n < VERSIONS; n++) {
      fs.writeFileSync(path.join(repo, "big.txt"), version(n));
      fx.git(repo, ["add", "-A"]);
      fx.git(repo, ["commit", "-q", "-m", "Version " + n]);
    }
  });

  afterAll(function () {
    fx.remove(work);
  });

  let dir;
  let store;
  let cache;
  let reserved;

  // Packs the repository as git would, and returns a reader over it which has
  // scratch (the cache), and counts what it is asked to reserve
  async function setup({ packs, maxBytes = 64 * MiB, maxSize = CAP, scratch = true, scratchConcurrency, store: given } = {}) {
    if (dir) fx.remove(dir);
    dir = fx.tempDir();
    store = given || createMemoryStore();
    cache = createCache({ dir: path.join(dir, "cache"), maxBytes });
    reserved = [];

    const entries = [];
    for (const pack of packs) entries.push(await fx.upload(store, pack, 0));

    const counting = {
      maxBytes,
      reserve: async (bytes) => {
        reserved.push(bytes);
        return cache.reserve(bytes);
      },
    };
    return createReader({ store, cache, packs: entries, maxSize, scratchConcurrency, scratch: scratch ? counting : null });
  }

  function teardown() {
    fx.remove(dir);
  }

  function repack(...args) {
    fx.git(repo, ["repack", "-adfq", "--window=50", "--depth=10", ...args]);
    return fx.readPacks(repo);
  }

  function describeBlobs(pack) {
    const entries = fx.listEntries(pack);
    const oids = fx.text(repo, ["rev-list", "--objects", "master"]).split("\n").filter((l) => /big\.txt/.test(l)).map((l) => l.split(" ")[0]);
    return oids.map((oid) => {
      const entry = entries.find((e) => e.oid === oid);
      return { oid, depth: entry.depth, size: Number(fx.text(repo, ["cat-file", "-s", oid])) };
    });
  }

  function expectNoScratch() {
    const scratch = path.join(dir, "cache", "scratch");
    expect(fs.existsSync(scratch) ? fs.readdirSync(scratch) : []).toEqual([]);
    expect(cache.stats().reservedBytes).toBe(0);
  }

  const want = (oid) => fx.git(repo, ["cat-file", "blob", oid]);

  describe("one pack with a chain of OFS_DELTA entries", function () {
    let packs;
    let reader;

    beforeAll(function () {
      packs = repack();
      blobs = describeBlobs(packs[0]);
    });

    beforeEach(async function () {
      reader = await setup({ packs });
    });
    afterEach(teardown);

    it("has deltas, some of them several deep", function () {
      expect(blobs.filter((b) => b.depth > 0).length).toBeGreaterThan(4);
      expect(Math.max(...blobs.map((b) => b.depth))).toBeGreaterThanOrEqual(3);
    });

    it("streams every version as git cat-file gives it", async function () {
      for (const { oid } of blobs) {
        const got = await reader.stream(oid);
        const data = await collect(got.data);
        expect(got.type).toBe("blob");
        expect(got.size).toBe(data.length);
        if (!data.equals(want(oid))) fail("Blob " + oid + " differs from git cat-file");
      }

      // The ones stored whole and the small ones need no scratch
      expect(reserved.length).toBe(blobs.filter((b) => b.depth > 0).length);
      expectNoScratch();
    });

    it("builds the deepest in chunks of at most 64 KB, and the files are gone by the end", async function () {
      const deepest = blobs.reduce((a, b) => (b.depth > a.depth ? b : a));
      const got = await reader.stream(deepest.oid);

      // The files exist while it streams: the last one, no earlier one
      const scratch = path.join(dir, "cache", "scratch");
      const [reservation] = fs.readdirSync(scratch);
      expect(fs.readdirSync(path.join(scratch, reservation)).length).toBe(1);

      let biggest = 0;
      const chunks = [];
      for await (const chunk of got.data) {
        biggest = Math.max(biggest, chunk.length);
        chunks.push(chunk);
      }
      expect(Buffer.concat(chunks).equals(want(deepest.oid))).toBe(true);
      expect(biggest).toBeLessThanOrEqual(64 * 1024);
      expectNoScratch();
    });

    it("takes room for two copies at most, not for each link of the chain", async function () {
      const deepest = blobs.reduce((a, b) => (b.depth > a.depth ? b : a));
      expect(deepest.depth).toBeGreaterThanOrEqual(3);

      let peak = 0;
      const timer = setInterval(() => (peak = Math.max(peak, cache.stats().reservedBytes)), 1);
      const got = await reader.stream(deepest.oid);
      peak = Math.max(peak, cache.stats().reservedBytes);
      await collect(got.data);
      clearInterval(timer);

      const size = fx.text(repo, ["cat-file", "-s", deepest.oid]);
      expect(peak).toBeGreaterThan(Number(size));
      expect(peak).toBeLessThan(2 * Number(size) + 64 * 1024);
      expectNoScratch();
    });

    it("keeps a delta-stored object under the cap in memory, with the requests it always took", async function () {
      const delta = blobs.find((b) => b.depth > 0);
      const counts = [];

      for (const scratch of [true, false]) {
        const counter = createCounter();
        const reader = await setup({ packs, maxSize: 64 * MiB, scratch, store: counter.store });
        await collect((await reader.stream(delta.oid)).data);
        counts.push(counter.requests());
        expect(reserved.length).toBe(0);
        teardown();
      }

      expect(counts[0]).toBe(counts[1]);
    });

    it("without scratch still refuses an object over the cap, as it always did", async function () {
      const plain = await setup({ packs, scratch: false });
      const delta = blobs.find((b) => b.depth > 0);
      const err = await failure(plain.stream(delta.oid));
      expect(err && err.code).toBe("TOO_LARGE");
    });
  });

  describe("REF_DELTA entries, one of them completed from another pack", function () {
    let early;
    let thin;
    let blobsInThin;

    beforeAll(function () {
      const commits = fx.text(repo, ["rev-list", "--reverse", "master"]).split("\n");
      early = fx.indexPack(fx.packRevs(repo, [commits[0]]));
      const thinPack = fx.packRevs(repo, [commits[VERSIONS - 1]], [commits[0]], { thin: true });
      const fixed = fx.fixThin(thinPack, [early]);
      thin = fx.cutThin(fixed, thinPack.readUInt32BE(8));
      blobsInThin = thin.entries.filter((e) => e.type === "blob").map((e) => e.oid);
    });

    afterEach(teardown);

    it("streams every blob as git does", async function () {
      const reader = await setup({ packs: [early, thin] });
      expect(blobsInThin.length).toBe(VERSIONS - 1);

      for (const oid of blobsInThin) {
        const got = await reader.stream(oid);
        if (!(await collect(got.data)).equals(want(oid))) fail("Blob " + oid + " differs from git cat-file");
      }

      expect(reserved.length).toBeGreaterThan(0);
      expectNoScratch();
    });

    it("cannot without the pack the base is in, and leaves nothing behind", async function () {
      const reader = await setup({ packs: [thin] });
      let failures = 0;

      for (const oid of blobsInThin) {
        const err = await failure(reader.stream(oid).then((got) => collect(got.data)));
        if (err) failures++;
      }

      expect(failures).toBeGreaterThan(0);
      expectNoScratch();
    });
  });

  describe("when something is wrong", function () {
    let packs;
    let deepest;

    beforeAll(function () {
      packs = repack();
      blobs = describeBlobs(packs[0]);
      deepest = blobs.reduce((a, b) => (b.depth > a.depth ? b : a));
    });

    afterEach(teardown);

    it("fails with a CorruptError when a delta is damaged, and leaves nothing behind", async function () {
      const entries = fx.listEntries(packs[0]);
      const at = entries.find((e) => e.oid === deepest.oid);
      const pack = Buffer.from(packs[0].pack);
      pack[at.offset + 24] ^= 0x55;

      const reader = await setup({ packs: [{ ...packs[0], pack }] });
      const err = await failure(reader.stream(deepest.oid).then((got) => collect(got.data)));

      expect(err).toEqual(jasmine.any(CorruptError));
      expectNoScratch();
    });

    it("fails with a CorruptError when the base is damaged, once its file is being written", async function () {
      const entries = fx.listEntries(packs[0]);
      const base = entries.filter((e) => e.type === "blob" && e.depth === 0).sort((a, b) => b.size - a.size)[0];
      const pack = Buffer.from(packs[0].pack);
      pack[base.offset + 4096] ^= 0x55;

      const reader = await setup({ packs: [{ ...packs[0], pack }] });
      const err = await failure(reader.stream(deepest.oid).then((got) => collect(got.data)));

      expect(err).toEqual(jasmine.any(CorruptError));
      expect(reserved.length).toBe(1);
      expectNoScratch();
    });

    it("fails with a CorruptError when a delta further down the chain is damaged", async function () {
      const entries = fx.listEntries(packs[0]);
      const delta = entries.filter((e) => e.type === "blob" && e.depth > 0).sort((a, b) => a.depth - b.depth)[0];
      const pack = Buffer.from(packs[0].pack);
      pack[delta.offset + 24] ^= 0x55;

      const reader = await setup({ packs: [{ ...packs[0], pack }] });
      const damaged = blobs.filter((b) => b.depth >= delta.depth);
      let failed = 0;

      for (const { oid } of damaged) {
        const err = await failure(reader.stream(oid).then((got) => collect(got.data)));
        if (err) {
          expect(err).toEqual(jasmine.any(CorruptError));
          failed++;
        }
      }

      expect(failed).toBeGreaterThan(0);
      expectNoScratch();
    });

    it("fails at the end of the stream, with a CorruptError, when the bytes are not the object", async function () {
      // An index which names the delta by an ID which is not its own
      const at = fx.listEntries(packs[0]).find((e) => e.oid === deepest.oid);
      const wrong = "ab".repeat(20);
      const idx = fx.buildIdx([{ oid: wrong, offset: at.offset }], packs[0].pack);

      const reader = await setup({ packs: [{ ...packs[0], idx }] });
      const got = await reader.stream(wrong);
      expect(got.size).toBe(deepest.size);

      const received = [];
      const err = await failure(
        (async () => {
          for await (const chunk of got.data) received.push(chunk);
        })()
      );

      expect(err).toEqual(jasmine.any(CorruptError));
      expect(Buffer.concat(received).equals(want(deepest.oid))).toBe(true);
      expectNoScratch();
    });

    it("fails with NoRoomError when the room for the base is taken just now, and works once it is free", async function () {
      const reader = await setup({ packs, maxBytes: 8 * MiB });
      const hold = await cache.reserve(7 * MiB);
      const err = await failure(reader.stream(deepest.oid));
      expect(err).toEqual(jasmine.any(NoRoomError));

      await hold.release();
      expect((await collect((await reader.stream(deepest.oid)).data)).equals(want(deepest.oid))).toBe(true);
      expectNoScratch();
    });

    it("fails with NoRoomError when there is room for one copy just now and not two", async function () {
      const reader = await setup({ packs, maxBytes: 5 * MiB });
      const hold = await cache.reserve(2.5 * MiB);
      const err = await failure(reader.stream(deepest.oid));
      expect(err).toEqual(jasmine.any(NoRoomError));
      expect(reserved.length).toBe(1);

      await hold.release();
      expectNoScratch();
    });

    it("fails with TooLargeError, naming the size, when the budget could never hold the base", async function () {
      const reader = await setup({ packs, maxBytes: 1 * MiB });
      const err = await failure(reader.stream(deepest.oid));
      expect(err && err.code).toBe("TOO_LARGE");
      expect(err.size).toBeGreaterThan(MiB);
      expect(reserved.length).toBe(0);
      expectNoScratch();
    });

    it("fails with TooLargeError when the budget could hold one copy and never two", async function () {
      const reader = await setup({ packs, maxBytes: Math.floor(deepest.size * 1.5) });
      const err = await failure(reader.stream(deepest.oid));
      expect(err && err.code).toBe("TOO_LARGE");
      expect(reserved.length).toBe(1);
      expectNoScratch();
    });
  });

  describe("several objects at once", function () {
    let packs;
    let big;

    beforeAll(function () {
      packs = repack();
      blobs = describeBlobs(packs[0]);
      big = blobs.filter((b) => b.depth > 0);
    });

    afterEach(teardown);

    async function peakWith(scratchConcurrency) {
      const reader = await setup({ packs, scratchConcurrency });
      let peak = 0;
      const timer = setInterval(() => (peak = Math.max(peak, cache.stats().reservedBytes)), 1);
      const results = await Promise.all(
        big.slice(0, 4).map(async (b) => {
          const got = await reader.stream(b.oid);
          return collect(got.data);
        })
      );
      clearInterval(timer);
      big.slice(0, 4).forEach((b, i) => expect(results[i].equals(want(b.oid))).toBe(true));
      expectNoScratch();
      return peak;
    }

    it("builds one at a time by default, so the room held is that of one", async function () {
      const peak = await peakWith(undefined);
      expect(peak).toBeLessThan(2 * FILE + 256 * 1024);
    });

    it("builds as many at once as it is told to", async function () {
      const peak = await peakWith(4);
      expect(peak).toBeGreaterThan(2 * FILE + 256 * 1024);
    });
  });

  describe("a delta which is not valid", function () {
    const base = Buffer.from("0123456789".repeat(40000));
    const name = "cd".repeat(20);

    afterEach(teardown);

    async function streamOf(deltaBytes, options) {
      const reader = await setup({ packs: [craft(base, deltaBytes, name)], maxSize: 1000, ...options });
      return failure(reader.stream(name).then((got) => collect(got.data)));
    }

    it("is applied, and the wrong ID is found at the end", async function () {
      // A well-formed delta, so the only fault is that the bytes are not `name`
      const good = delta(base.length, 20, copy(5, 10), insert("0123456789"));
      const reader = await setup({ packs: [craft(base, good, name)], maxSize: 1000 });
      const got = await reader.stream(name);

      expect(got.size).toBe(20);
      const err = await failure(collect(got.data));
      expect(err).toEqual(jasmine.any(CorruptError));
      expect(err.message).toMatch(/different object/);
      expectNoScratch();
    });

    it("is refused when it was made against a base of another size", async function () {
      const err = await streamOf(delta(base.length + 1, 3, insert("abc")));
      expect(err).toEqual(jasmine.any(CorruptError));
      expect(err.message).toMatch(/does not match its base/);
      expectNoScratch();
    });

    it("is refused when it copies from outside the base", async function () {
      const err = await streamOf(delta(base.length, 20, copy(base.length - 5, 20)));
      expect(err).toEqual(jasmine.any(CorruptError));
      expect(err.message).toMatch(/outside its base/);
      expectNoScratch();
    });

    it("is refused when it writes past its target size", async function () {
      const err = await streamOf(delta(base.length, 5, insert("abcdefgh")));
      expect(err).toEqual(jasmine.any(CorruptError));
      expectNoScratch();
    });

    it("is refused when it writes less than its target size", async function () {
      const err = await streamOf(delta(base.length, 50, insert("abc")));
      expect(err).toEqual(jasmine.any(CorruptError));
      expect(err.message).toMatch(/wrong size/);
      expectNoScratch();
    });

    it("is refused when it ends in the middle of an instruction", async function () {
      const err = await streamOf(delta(base.length, 5, insert("abc").subarray(0, 3), Buffer.alloc(0)));
      expect(err).toEqual(jasmine.any(CorruptError));
      expectNoScratch();
    });

    it("is refused when it uses the reserved instruction", async function () {
      const err = await streamOf(delta(base.length, 3, Buffer.from([0]), insert("abc")));
      expect(err).toEqual(jasmine.any(CorruptError));
      expect(err.message).toMatch(/reserved/);
      expectNoScratch();
    });

    it("is built in scratch when its result fits the cap and its base does not", async function () {
      // The cap is above the result and below the base: the base cannot be
      // held, so the object is built in scratch although it is small
      const good = delta(base.length, 20, copy(0, 10), copy(10, 10));
      const reader = await setup({ packs: [craft(base, good, blobId(base.subarray(0, 20)))], maxSize: 1000 });
      const got = await reader.stream(blobId(base.subarray(0, 20)));

      expect(got.size).toBe(20);
      expect((await collect(got.data)).equals(base.subarray(0, 20))).toBe(true);
      expect(reserved).toEqual([base.length]);
      expectNoScratch();
    });

    it("is applied when a copy is longer than the output buffer", async function () {
      const big = crypto.randomBytes(3 * MiB + 17);
      const text = "x".repeat(100);
      const ops = [copy(0, 2 * MiB + 5), insert(text), copy(1000, MiB)];
      const target = Buffer.concat([big.subarray(0, 2 * MiB + 5), Buffer.from(text), big.subarray(1000, 1000 + MiB)]);
      const reader = await setup({ packs: [craft(big, delta(big.length, target.length, ...ops), blobId(target))], maxSize: 1000 });
      const got = await reader.stream(blobId(target));

      expect((await collect(got.data)).equals(target)).toBe(true);
      expectNoScratch();
    });
  });

  describe("memory", function () {
    // How much the memory of a process grows streaming an object (see
    // helpers/measureStream.js)
    function measure(packDir, scratchDir, oid, maxSize) {
      return new Promise((resolve, reject) => {
        execFile(
          process.execPath,
          ["--expose-gc", path.join(__dirname, "helpers/measureStream.js"), packDir, scratchDir, oid, String(maxSize)],
          { maxBuffer: 1 << 20 },
          function (err, stdout, stderr) {
            if (err) return reject(new Error(err.message + stderr));
            resolve(JSON.parse(stdout));
          }
        );
      });
    }

    it("streams a delta-stored object many times the in-memory cap in constant memory", async function () {
      const SIZE = 24 * MiB;
      const CAP_BYTES = 2 * MiB;
      const big = path.join(work, "big");
      fs.mkdirSync(big);
      fx.git(big, ["init", "-q", "-b", "master"]);

      for (let n = 0; n < 5; n++) {
        fs.writeFileSync(path.join(big, "big.txt"), version(n, SIZE));
        fx.git(big, ["add", "-A"]);
        fx.git(big, ["commit", "-q", "-m", "Version " + n]);
      }
      fx.git(big, ["repack", "-adfq", "--window=50", "--depth=10"]);

      const [pack] = fx.readPacks(big);
      const oids = fx.text(big, ["rev-list", "--objects", "master"]).split("\n").filter((l) => /big\.txt/.test(l)).map((l) => l.split(" ")[0]);
      const entries = fx.listEntries(pack);
      const deltas = oids.map((oid) => entries.find((e) => e.oid === oid)).filter((e) => e.depth > 0);
      const deepest = deltas.reduce((a, b) => (b.depth > a.depth ? b : a));

      expect(deepest.depth).toBeGreaterThanOrEqual(2);

      const scratchDir = path.join(work, "memory-scratch");
      const result = await measure(path.join(big, ".git", "objects", "pack"), scratchDir, deepest.oid, CAP_BYTES);
      const real = Number(fx.text(big, ["cat-file", "-s", deepest.oid]));

      expect(result.bytes).toBe(real);
      expect(result.size).toBe(real);
      expect(real).toBeGreaterThan(10 * CAP_BYTES);

      // Resolving it in memory holds the base and the result: twice the object
      // at the least. Streaming holds a few buffers (it was 5 to 7 MiB here,
      // most of it the 1 MiB reads of the base and zlib's own output).
      expect(result.growth).toBeLessThan(real / 2);
      expect(fs.readdirSync(path.join(scratchDir, "scratch"))).toEqual([]);

      // The control: with a cap above the object it is resolved in memory, and
      // the measure sees that
      const inMemory = await measure(path.join(big, ".git", "objects", "pack"), scratchDir, deepest.oid, 64 * MiB);
      expect(inMemory.bytes).toBe(real);
      expect(inMemory.growth).toBeGreaterThan(real);
    }, 120 * 1000);
  });

  describe("a consumer which stops early", function () {
    let packs;
    let deepest;
    let reader;

    beforeAll(function () {
      packs = repack();
      blobs = describeBlobs(packs[0]);
      deepest = blobs.reduce((a, b) => (b.depth > a.depth ? b : a));
    });

    beforeEach(async function () {
      reader = await setup({ packs });
    });
    afterEach(teardown);

    it("leaves no scratch files when it leaves a for await after one chunk", async function () {
      const got = await reader.stream(deepest.oid);
      for await (const chunk of got.data) {
        expect(chunk.length).toBeGreaterThan(0);
        break;
      }
      expectNoScratch();
    });

    it("leaves no scratch files when it calls return() without ever reading", async function () {
      const got = await reader.stream(deepest.oid);
      expect(cache.stats().reservedBytes).toBeGreaterThan(0);

      await got.data[Symbol.asyncIterator]().return();
      expectNoScratch();
      await got.data[Symbol.asyncIterator]().return();
      expectNoScratch();
    });

    it("leaves no scratch files when a Readable made from it is destroyed", async function () {
      const got = await reader.stream(deepest.oid);
      const body = Readable.from(got.data, { objectMode: false });

      await new Promise((resolve) => body.once("data", resolve));
      await new Promise((resolve) => {
        body.once("close", resolve);
        body.destroy();
      });

      expectNoScratch();
    });

    it("leaves no scratch files when the Readable is destroyed before it reads", async function () {
      const got = await reader.stream(deepest.oid);
      const body = Readable.from(got.data, { objectMode: false });

      await new Promise((resolve) => {
        body.once("close", resolve);
        body.destroy();
      });

      expectNoScratch();
    });
  });
});

// An object store which counts the requests it is asked for
function createCounter() {
  const store = createMemoryStore();
  return { store, requests: () => store.stats.heads + store.stats.reads + store.stats.gets + store.stats.lists };
}
