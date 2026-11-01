// Finds an object's offset in a pack by reading its version 2 .idx by range.
//
// The index is, in order: an 8-byte header, a 256-entry fanout (how many
// objects have a first byte up to each value), the N sorted 20-byte object
// IDs, N CRC-32s, N 4-byte pack offsets, 8-byte offsets for the few packs
// bigger than 2 GB, then two checksums. So a lookup needs the fanout (1 KB),
// then only the slice of IDs and offsets sharing the object ID's first byte,
// about N/256 entries. Both are kept in the cache, so after the first lookup
// near an ID the next is free. On a cold cache it costs three small reads.
const { CorruptError } = require("./errors");
const { readRanges } = require("./ranges");

const MAGIC = Buffer.from([0xff, 0x74, 0x4f, 0x63]);
const FANOUT_END = 8 + 256 * 4;
const TRAILER = 40;

// A bucket this big (bytes of IDs and offsets, about 150,000 objects sharing a
// first byte) is not worth reading whole, so it is searched with small reads.
// A repository of ordinary size never gets there; it keeps a hostile or
// broken index from asking for hundreds of megabytes.
const MAX_BUCKET_BYTES = 4 * 1024 * 1024;

// Where in an index the sections start, for an index of `count` objects
function layout(count) {
  const ids = FANOUT_END;
  const crcs = ids + count * 20;
  const offsets = crcs + count * 4;
  const large = offsets + count * 4;
  return { ids, offsets, large };
}

function parseFanout(buffer, indexSize, name) {
  if (buffer.length < FANOUT_END || !buffer.subarray(0, 4).equals(MAGIC) || buffer.readUInt32BE(4) !== 2) {
    throw new CorruptError(name + " is not a version 2 pack index");
  }

  const fanout = new Array(256);
  let previous = 0;
  for (let i = 0; i < 256; i++) {
    fanout[i] = buffer.readUInt32BE(8 + i * 4);
    if (fanout[i] < previous) throw new CorruptError(name + " has a fanout which goes backwards");
    previous = fanout[i];
  }

  const count = fanout[255];
  if (indexSize < layout(count).large + TRAILER) throw new CorruptError(name + " is shorter than its fanout says");
  return fanout;
}

function toOffset(value) {
  if (!Number.isSafeInteger(value)) throw new CorruptError("Pack offset is out of range");
  return value;
}

// Opens a pack's index. `store` and `key` say where it is, `size` is its
// length (from the manifest), `cache` (optional) and `namespace` say where
// cached parts go.
function openIndex({ store, key, size, cache, namespace }) {
  const cacheKey = (part) => namespace + "/" + key + "/" + part;

  // A cached part of the wrong length is not trusted: it is fetched again
  async function cached(part, length, fetch) {
    const hit = cache && (await cache.get(cacheKey(part)));
    if (hit && hit.length === length) return hit;
    const fresh = await fetch();
    if (cache) await cache.put(cacheKey(part), fresh);
    return fresh;
  }

  async function fanout() {
    const buffer = await cached("fanout", FANOUT_END, () => store.read(key, 0, FANOUT_END));
    return parseFanout(buffer, size, key);
  }

  // The IDs then the offsets of objects [from, to) in index order
  async function readBucket(count, from, to) {
    const where = layout(count);
    const [ids, offsets] = await readRanges(store, key, [
      { offset: where.ids + from * 20, length: (to - from) * 20 },
      { offset: where.offsets + from * 4, length: (to - from) * 4 },
    ]);
    if (ids.length !== (to - from) * 20 || offsets.length !== (to - from) * 4) {
      throw new CorruptError(key + " is truncated");
    }
    return Buffer.concat([ids, offsets]);
  }

  // Resolves the stored 4-byte offset, which for big packs points into the
  // table of 8-byte offsets
  async function resolveOffset(count, position, raw) {
    if (!(raw & 0x80000000)) return raw;

    const slot = raw & 0x7fffffff;
    const at = layout(count).large + slot * 8;
    if (at + 8 > size - TRAILER) throw new CorruptError(key + " has an offset outside its table");
    const bytes = await store.read(key, at, 8);
    if (bytes.length !== 8) throw new CorruptError(key + " is truncated");
    return toOffset(Number(bytes.readBigUInt64BE(0)));
  }

  // Binary search in a bucket of [ids...][offsets...] holding `n` objects
  function search(bucket, n, id) {
    let low = 0;
    let high = n;
    while (low < high) {
      const mid = (low + high) >>> 1;
      const order = Buffer.compare(bucket.subarray(mid * 20, mid * 20 + 20), id);
      if (order === 0) return mid;
      if (order < 0) low = mid + 1;
      else high = mid;
    }
    return -1;
  }

  async function searchBySmallReads(count, from, to, id) {
    let low = from;
    let high = to;
    while (low < high) {
      const mid = (low + high) >>> 1;
      const found = await store.read(key, layout(count).ids + mid * 20, 20);
      const order = Buffer.compare(found, id);
      if (order === 0) {
        const raw = await store.read(key, layout(count).offsets + mid * 4, 4);
        return resolveOffset(count, mid, raw.readUInt32BE(0));
      }
      if (order < 0) low = mid + 1;
      else high = mid;
    }
    return null;
  }

  // The offset of object `oid` (40 hex characters) in the pack, or null
  async function lookup(oid) {
    const id = Buffer.from(oid, "hex");
    const table = await fanout();
    const count = table[255];
    const first = id[0];
    const from = first === 0 ? 0 : table[first - 1];
    const to = table[first];

    if (from === to) return null;
    if ((to - from) * 24 > MAX_BUCKET_BYTES) return searchBySmallReads(count, from, to, id);

    const n = to - from;
    const bucket = await cached("bucket/" + first, n * 24, () => readBucket(count, from, to));
    const found = search(bucket, n, id);
    if (found < 0) return null;
    return resolveOffset(count, from + found, bucket.readUInt32BE(n * 20 + found * 4));
  }

  return { lookup, objectCount: async () => (await fanout())[255] };
}

module.exports = { openIndex };
