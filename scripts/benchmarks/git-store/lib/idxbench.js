// Index lookups at scale. Writes a synthetic version 2 pack index of random
// object IDs (an index is all a lookup reads), uploads it, and times lookups
// of IDs it has and IDs it does not, cold and warm, through the foundation's
// index reader and the reader's locate (which asks every pack).
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { createCache, createReader } = require("../../../../app/clients/git/store");
const { idxKey } = require("../../../../app/clients/git/store").layout;
const { connect, ensureBucket } = require("./stores");
const toxiproxy = require("./toxiproxy");
const { mulberry32 } = require("./generate");
const { removeRepo } = require("./upload");
const { WORK, median } = require("./session");

// Writes a synthetic index of `count` objects to `file`, returning a sample of
// the IDs it holds. IDs are random, so buckets differ in size as real ones do.
function writeIndex(file, count, seed, sampleSize = 2000) {
  const rand = mulberry32(seed);
  const buckets = new Array(256).fill(0);
  for (let i = 0; i < count; i++) buckets[Math.floor(rand() * 256)]++;

  const fd = fs.openSync(file, "w");
  const header = Buffer.alloc(8 + 1024);
  header.writeUInt32BE(0xff744f63, 0);
  header.writeUInt32BE(2, 4);
  let total = 0;
  buckets.forEach((n, i) => {
    total += n;
    header.writeUInt32BE(total, 8 + i * 4);
  });
  fs.writeSync(fd, header);

  const sample = [];
  const every = Math.max(1, Math.floor(count / sampleSize));
  let index = 0;
  for (let b = 0; b < 256; b++) {
    const ids = [];
    for (let i = 0; i < buckets[b]; i++) {
      const id = Buffer.alloc(20);
      id[0] = b;
      for (let k = 1; k < 20; k += 4) id.writeUInt32LE(Math.floor(rand() * 4294967296), Math.min(k, 16));
      ids.push(id);
    }
    ids.sort(Buffer.compare);
    for (const id of ids) {
      if (index++ % every === 0) sample.push(id.toString("hex"));
    }
    fs.writeSync(fd, Buffer.concat(ids));
  }
  const crc = Buffer.alloc(count * 4);
  fs.writeSync(fd, crc);
  const off = Buffer.alloc(count * 4);
  for (let i = 0; i < count; i++) off.writeUInt32BE(12 + (i % 0x7ffffff0), i * 4);
  fs.writeSync(fd, off);
  fs.writeSync(fd, crypto.randomBytes(40));
  fs.closeSync(fd);
  return sample;
}

async function build({ blogID, packs, perPack }) {
  await ensureBucket();
  const { store, close } = connect({ blogID, via: "direct" });
  await removeRepo(store);
  fs.mkdirSync(path.join(WORK, "idx"), { recursive: true });
  const entries = [];
  const samples = [];
  for (let p = 0; p < packs; p++) {
    const name = "pack-" + crypto.createHash("sha1").update(blogID + p).digest("hex");
    const file = path.join(WORK, "idx", name + ".idx");
    samples.push(writeIndex(file, perPack, 100 + p));
    const size = fs.statSync(file).size;
    await store.put(idxKey(name), fs.createReadStream(file));
    fs.unlinkSync(file);
    entries.push({ name, size: 1 << 30, idxSize: size, objects: perPack, seq: p + 1 });
  }
  close();
  return { entries, samples };
}

// Looks up `ids` in turn through `lookup`, returning per-lookup requests,
// bytes and time
async function measure(server, ids, lookup) {
  const rows = [];
  for (const id of ids) {
    server.counters.take();
    const t = process.hrtime.bigint();
    const found = await lookup(id);
    const ms = Number(process.hrtime.bigint() - t) / 1e6;
    const counts = server.counters.take();
    const requests = Object.values(counts.http).reduce((n, r) => n + r.n, 0);
    rows.push({ requests, bytes: counts.bytesIn, ms, found: found !== null });
  }
  return rows;
}

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);

async function idxSuite({ profile, record, packs = 1, perPack = 10_000_000, cacheBytes = 1024 ** 3, label }) {
  const blogID = "idx-" + packs + "x" + perPack;
  const built = await build({ blogID, packs, perPack });
  await toxiproxy.useProfile(profile);
  const cacheDir = path.join(WORK, "cache-" + blogID);
  fs.rmSync(cacheDir, { recursive: true, force: true });
  const cache = createCache({ dir: cacheDir, maxBytes: cacheBytes });
  await cache.ready();
  const server = connect({ blogID, via: profile === "direct" ? "direct" : "proxied" });
  const reader = createReader({ store: server.store, cache, packs: built.entries });

  const rand = mulberry32(5);
  const hits = built.samples.flat();
  const present = (n) => Array.from({ length: n }, () => hits[Math.floor(rand() * hits.length)]);
  const absent = (n) => Array.from({ length: n }, () => crypto.randomBytes(20).toString("hex"));
  const ids = (n) => [...present(Math.ceil(n / 2)), ...absent(Math.floor(n / 2))].sort(() => rand() - 0.5);

  const phases = [
    ["cold, first lookup", 1],
    ["cold, first 50", 50],
    ["after 500", 500],
    ["after 2000 (steady)", 1500],
  ];
  const total = [];
  for (const [phase, n] of phases) {
    const rows = await measure(server, ids(n), (id) => reader.locate(id));
    total.push(...rows);
    record({
      suite: "index",
      repo: label || blogID,
      profile,
      phase,
      packs,
      objects: packs * perPack,
      cacheMB: cacheBytes / 1048576,
      lookups: rows.length,
      requestsPerLookup: mean(rows.map((r) => r.requests)),
      kbPerLookup: mean(rows.map((r) => r.bytes)) / 1024,
      msPerLookup: mean(rows.map((r) => r.ms)),
      medianMs: median(rows.map((r) => r.ms)),
      allFound: rows.filter((r) => r.found).length,
      cacheEntries: cache.stats().entries,
      cacheMB_used: Math.round(cache.stats().entryBytes / 1048576),
    });
  }

  server.close();
  fs.rmSync(cacheDir, { recursive: true, force: true });
}

async function cleanup(blogID) {
  const { store, close } = connect({ blogID, via: "direct" });
  await removeRepo(store);
  close();
}

module.exports = { idxSuite, cleanup };
