// Reads objects by ID from a repository's live packs, entirely by range.
//
// An object is found by asking each pack's index (idx.js) for its offset; a
// pack entry is read with pack.js; a delta is resolved by reading its base,
// which is either earlier in the same pack (OFS_DELTA) or any object in any of
// the repository's packs (REF_DELTA, which is how the packs `index-pack
// --fix-thin` completes refer to what a push did not send).
//
// Memory is bounded by `maxSize`, the largest object a caller will hold. A
// delta chain is applied one link at a time, so it costs the base plus the
// chain's deltas plus the result, never the whole chain's intermediate
// objects. Every object read by ID is hashed and compared with the ID it was
// asked for, so bytes which are wrong in any way (a flipped bit, a bad offset,
// a truncated pack, a mismatched base) are an error rather than a result.
const crypto = require("crypto");
const { CorruptError, NotFoundError, TooLargeError } = require("./errors");
const { applyDelta } = require("./delta");
const { openIndex } = require("./idx");
const { openPack, isDelta } = require("./pack");
const { packKey, idxKey } = require("./layout");
const { mapLimit } = require("./limit");

// Git's own limit on a chain is 4095; anything longer is a loop or an attack
const MAX_CHAIN = 5000;

const DEFAULT_MAX_SIZE = 64 * 1024 * 1024;

const LOOKUP_CONCURRENCY = 8;

function objectHasher(type, size) {
  return crypto.createHash("sha1").update(type + " " + size + "\0");
}

// `packs` are manifest pack entries ({ name, size, idxSize }), oldest first.
// `cache` is optional: without it every lookup goes to the object store.
function createReader({ store, cache = null, packs, maxSize = DEFAULT_MAX_SIZE }) {
  const opened = packs.map((entry) => ({
    name: entry.name,
    pack: openPack({ store, key: packKey(entry.name), size: entry.size, name: entry.name }),
    index: openIndex({
      store,
      key: idxKey(entry.name),
      size: entry.idxSize,
      cache,
      namespace: store.id,
    }),
  }));
  const byName = new Map(opened.map((p) => [p.name, p]));

  // Where object `oid` is: { pack, offset } in the newest pack holding it, or
  // null. Every pack is asked at once, since each answer may be a cache hit.
  async function locate(oid) {
    const offsets = await mapLimit(opened, LOOKUP_CONCURRENCY, (p) => p.index.lookup(oid));
    for (let i = opened.length - 1; i >= 0; i--) {
      if (offsets[i] !== null) return { pack: opened[i], offset: offsets[i] };
    }
    return null;
  }

  // Follows a delta's base: an offset in the same pack, or an ID anywhere
  async function baseOf(at, entry) {
    if (entry.baseOffset !== undefined) return { pack: at.pack, offset: entry.baseOffset };

    const found = await locate(entry.baseOid);
    if (!found) throw new NotFoundError("Delta base " + entry.baseOid + " is not in any pack");
    return found;
  }

  // Resolves the entry at `start` ({ pack, offset }) to a whole object
  async function resolve(start, limit = maxSize) {
    const deltas = [];
    const visited = new Set();
    let held = 0;
    let at = start;
    let base;

    for (;;) {
      const id = at.pack.name + ":" + at.offset;
      if (visited.has(id) || visited.size >= MAX_CHAIN) throw new CorruptError("Delta chain does not end");
      visited.add(id);

      const entry = await at.pack.pack.read(at.offset, limit);
      if (!isDelta(entry)) {
        base = entry;
        break;
      }

      held += entry.data.length;
      if (held > limit) throw new TooLargeError("Delta chain is larger than " + limit + " bytes");
      deltas.push(entry.data);
      at = await baseOf(at, entry);
    }

    let data = base.data;
    for (let i = deltas.length - 1; i >= 0; i--) data = applyDelta(data, deltas[i], limit);
    return { type: base.type, data };
  }

  function check(oid, type, data) {
    const hash = objectHasher(type, data.length).update(data).digest("hex");
    if (hash !== oid) throw new CorruptError("Object " + oid + " read back as " + hash);
  }

  async function has(oid) {
    return (await locate(oid)) !== null;
  }

  // The object `oid` as { type, size, data }, or null if no pack has it.
  // Throws CorruptError if what the packs hold for it is not it.
  async function read(oid, { maxSize: limit = maxSize } = {}) {
    const at = await locate(oid);
    if (!at) return null;

    const { type, data } = await resolve(at, limit);
    check(oid, type, data);
    return { type, size: data.length, data };
  }

  // Like read, but the data is an async iterable of chunks when the object is
  // stored whole, so an object of any size costs bounded memory. The chunks
  // are hashed as they go: the iteration throws CorruptError at its end if the
  // object isn't `oid`, so the caller must not treat the data as good until
  // then. An object stored as a delta is resolved in memory, and so is
  // limited by maxSize.
  async function stream(oid, { maxSize: limit = maxSize } = {}) {
    const at = await locate(oid);
    if (!at) return null;

    const entry = await at.pack.pack.open(at.offset);
    if (isDelta(entry)) {
      entry.output.return();
      const { type, data } = await resolve(at, limit);
      check(oid, type, data);
      return { type, size: data.length, data: (async function* () { yield data; })() };
    }

    const hash = objectHasher(entry.type, entry.size);
    async function* verified() {
      for await (const chunk of entry.output) {
        hash.update(chunk);
        yield chunk;
      }
      if (hash.digest("hex") !== oid) throw new CorruptError("Object " + oid + " read back as a different object");
    }
    return { type: entry.type, size: entry.size, data: verified() };
  }

  return { packs: opened.map((p) => p.name), has, locate, read, stream, pack: (name) => byName.get(name) };
}

module.exports = createReader;
