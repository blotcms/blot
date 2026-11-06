// Finds an object's offset in a pack from its version 2 .idx.
//
// The index is, in order: an 8-byte header, a 256-entry fanout (how many
// objects have a first byte up to each value), the N sorted 20-byte object
// IDs, N CRC-32s, N 4-byte pack offsets, 8-byte offsets for the few packs
// bigger than 2 GB, then two checksums (the pack's, and the index's own: a
// SHA-1 of everything before it).
//
// Two ways to read it:
//
// - Whole. An index of up to MAX_WHOLE bytes is fetched with one GET, checked
//   (the length the manifest says, its structure, and its own checksum), kept
//   in the cache under the pack's name, and held in memory while it is open.
//   A pack never changes, so a cached index is never checked against the store
//   again, and every lookup after the first is a binary search in memory with
//   no request. This is the usual case: about 28 bytes an object, so 4 MiB is
//   about 150,000 objects in one pack.
// - By range, for an index too big for that, or one the reader's budget for
//   whole indexes does not stretch to (see chooseWhole): the fanout (1 KB),
//   then only the slice of IDs and offsets sharing the object ID's first byte,
//   about N/256 entries. Both are kept in the cache, so after the first lookup
//   near an ID the next is free. On a cold cache it costs three small reads.
const crypto = require("crypto");
const { CorruptError, NotFoundError, TooLargeError } = require("./errors");
const { readRanges } = require("./ranges");

const MAGIC = Buffer.from([0xff, 0x74, 0x4f, 0x63]);
const FANOUT_END = 8 + 256 * 4;
const TRAILER = 40;

const MiB = 1024 * 1024;

// The largest index read whole
const MAX_WHOLE = 4 * MiB;

// The most bytes of whole indexes one reader (or clone) holds, and so the
// most one repository puts in the cache at once: no more than this, and no
// more than a sixteenth of the cache (64 MiB of a 1 GB cache, so the limit is
// this). Past it the rest of a repository's indexes are read by range, as
// before, rather than whole indexes evicting each other from a cache too small
// for them (see chooseWhole).
const WHOLE_BUDGET = 16 * MiB;
const CACHE_SHARE = 16;

// Which of `packs` (manifest entries, oldest first) have their index read
// whole: the newest first, each up to MAX_WHOLE, while the total stays within
// the budget. The newest are the small packs of recent pushes, of which there
// can be many, and whose objects most lookups are about; a big old base pack
// which does not fit is read by range, and its slices are cached as they always
// were. So a repository whose indexes fit is read with one GET per pack, once,
// and one whose indexes do not degrades to the reads by range of before for
// what does not fit, never to fetching whole indexes again and again.
function chooseWhole(packs, cache) {
  const budget = Math.min(
    WHOLE_BUDGET,
    cache ? Math.floor(cache.maxBytes / CACHE_SHARE) : WHOLE_BUDGET
  );
  const chosen = new Set();
  let total = 0;
  for (let i = packs.length - 1; i >= 0; i--) {
    const size = packs[i].idxSize;
    if (size > MAX_WHOLE || total + size > budget) continue;
    chosen.add(packs[i].name);
    total += size;
  }
  return chosen;
}

// Where a whole index is kept in the cache
const wholeKey = (namespace, key) => namespace + "/" + key + "/whole";

// Throws CorruptError unless `buffer` is a whole version 2 index of `size`
// bytes (the manifest's) whose own checksum is right. `checksum` false skips
// the hash, for an index this process wrote or already checked.
function checkWhole(buffer, size, name, { checksum = true } = {}) {
  if (buffer.length !== size)
    throw new CorruptError(
      name + " is " + buffer.length + " bytes; the manifest says " + size
    );
  parseFanout(buffer, size, name);
  if (checksum) {
    const own = crypto
      .createHash("sha1")
      .update(buffer.subarray(0, size - 20))
      .digest();
    if (!own.equals(buffer.subarray(size - 20)))
      throw new CorruptError(name + " does not match its checksum");
  }
}

// The whole index `key` (`size` bytes, as the manifest says): from the cache,
// or fetched with one GET, checked, and put in the cache. A cached copy of the
// wrong length is not trusted, and is fetched again.
async function loadWhole({ store, key, size, cache, namespace }) {
  const cacheKey = wholeKey(namespace, key);
  const hit = cache && (await cache.get(cacheKey).catch(() => null));
  if (hit && hit.length === size) {
    checkWhole(hit, size, key, { checksum: false });
    return hit;
  }

  let fresh;
  try {
    fresh = await store.get(key, { maxBytes: size });
  } catch (err) {
    if (err instanceof NotFoundError)
      throw new NotFoundError(key + " is not in the store");
    if (err instanceof TooLargeError)
      throw new CorruptError(
        key + " is larger than the " + size + " bytes the manifest says"
      );
    throw err;
  }
  checkWhole(fresh, size, key);
  if (cache) await cache.put(cacheKey, fresh).catch(() => false);
  return fresh;
}

// Puts an index this process has just written or uploaded (receive, commit) in
// the cache as a whole index, so the next reader of the pack makes no request
// for it. Indexes too big to be read whole are not.
async function rememberWhole({ cache, namespace, key, idx }) {
  if (
    !cache ||
    idx.length > MAX_WHOLE ||
    idx.length > Math.floor(cache.maxBytes / CACHE_SHARE)
  )
    return false;
  return cache.put(wholeKey(namespace, key), idx).catch(() => false);
}

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
  if (
    buffer.length < FANOUT_END ||
    !buffer.subarray(0, 4).equals(MAGIC) ||
    buffer.readUInt32BE(4) !== 2
  ) {
    throw new CorruptError(name + " is not a version 2 pack index");
  }

  const fanout = new Array(256);
  let previous = 0;
  for (let i = 0; i < 256; i++) {
    fanout[i] = buffer.readUInt32BE(8 + i * 4);
    if (fanout[i] < previous)
      throw new CorruptError(name + " has a fanout which goes backwards");
    previous = fanout[i];
  }

  const count = fanout[255];
  if (indexSize < layout(count).large + TRAILER)
    throw new CorruptError(name + " is shorter than its fanout says");
  return fanout;
}

function toOffset(value) {
  if (!Number.isSafeInteger(value))
    throw new CorruptError("Pack offset is out of range");
  return value;
}

// Opens a pack's index. `store` and `key` say where it is, `size` is its
// length (from the manifest), `cache` (optional) and `namespace` say where
// cached parts go. With `whole` the index is read whole, once, on the first
// lookup or `load()`, and held in memory; otherwise by range.
function openIndex({ store, key, size, cache, namespace, whole = false }) {
  const cacheKey = (part) => namespace + "/" + key + "/" + part;

  // Parts being fetched right now, by name: concurrent lookups which need the
  // same part wait for one fetch rather than each making their own
  const flights = new Map();

  // A cached part of the wrong length is not trusted: it is fetched again, and
  // a fetched part of the wrong length (a body cut short) is not cached
  function cached(part, length, fetch) {
    const name = cacheKey(part);
    if (flights.has(name)) return flights.get(name);

    const flight = (async () => {
      const hit = cache && (await cache.get(name));
      if (hit && hit.length === length) return hit;
      const fresh = await fetch();
      if (cache && fresh.length === length) await cache.put(name, fresh);
      return fresh;
    })().finally(() => flights.delete(name));

    flights.set(name, flight);
    return flight;
  }

  // The index in the store must be the length the manifest says. Checked
  // once, when a part is first fetched; a part already in the cache was
  // checked when it went in.
  let sized = null;
  function checkSize() {
    if (!sized) {
      sized = store
        .head(key)
        .then((found) => {
          if (!found) throw new NotFoundError(key + " is not in the store");
          if (found.size !== size)
            throw new CorruptError(
              key + " is " + found.size + " bytes; the manifest says " + size
            );
        })
        .catch((err) => {
          sized = null;
          throw err;
        });
    }
    return sized;
  }

  async function fanout() {
    const buffer = await cached("fanout", FANOUT_END, async () => {
      const [fresh] = await Promise.all([
        store.read(key, 0, FANOUT_END),
        checkSize(),
      ]);
      return fresh;
    });
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
    if (at + 8 > size - TRAILER)
      throw new CorruptError(key + " has an offset outside its table");
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
      const order = Buffer.compare(
        bucket.subarray(mid * 20, mid * 20 + 20),
        id
      );
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

  // The whole index, fetched once; a failed fetch is tried again next time
  let held = null;
  function load() {
    if (!whole) return Promise.resolve(null);
    if (!held) {
      held = loadWhole({ store, key, size, cache, namespace }).catch((err) => {
        held = null;
        throw err;
      });
    }
    return held;
  }

  // The offset of object `id` (a Buffer) in the whole index `buffer`, or null
  function lookupWhole(buffer, id) {
    const count = buffer.readUInt32BE(FANOUT_END - 4);
    const first = id[0];
    const from = first === 0 ? 0 : buffer.readUInt32BE(8 + (first - 1) * 4);
    const to = buffer.readUInt32BE(8 + first * 4);
    const where = layout(count);

    let low = from;
    let high = to;
    while (low < high) {
      const mid = (low + high) >>> 1;
      const at = where.ids + mid * 20;
      const order = Buffer.compare(buffer.subarray(at, at + 20), id);
      if (order === 0) {
        const raw = buffer.readUInt32BE(where.offsets + mid * 4);
        if (!(raw & 0x80000000)) return raw;
        const slot = where.large + (raw & 0x7fffffff) * 8;
        if (slot + 8 > size - TRAILER)
          throw new CorruptError(key + " has an offset outside its table");
        return toOffset(Number(buffer.readBigUInt64BE(slot)));
      }
      if (order < 0) low = mid + 1;
      else high = mid;
    }
    return null;
  }

  // The offset of object `oid` (40 hex characters) in the pack, or null
  async function lookup(oid) {
    const id = Buffer.from(oid, "hex");
    if (whole) return lookupWhole(await load(), id);
    const table = await fanout();
    const count = table[255];
    const first = id[0];
    const from = first === 0 ? 0 : table[first - 1];
    const to = table[first];

    if (from === to) return null;
    if ((to - from) * 24 > MAX_BUCKET_BYTES)
      return searchBySmallReads(count, from, to, id);

    const n = to - from;
    const bucket = await cached("bucket/" + first, n * 24, () =>
      readBucket(count, from, to)
    );
    const found = search(bucket, n, id);
    if (found < 0) return null;
    return resolveOffset(
      count,
      from + found,
      bucket.readUInt32BE(n * 20 + found * 4)
    );
  }

  return {
    lookup,
    load,
    whole,
    objectCount: async () =>
      whole
        ? (await load()).readUInt32BE(FANOUT_END - 4)
        : (await fanout())[255],
  };
}

module.exports = {
  openIndex,
  chooseWhole,
  loadWhole,
  rememberWhole,
  wholeKey,
  MAX_WHOLE,
  WHOLE_BUDGET,
};
