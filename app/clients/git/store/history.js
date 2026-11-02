// Reads the repository's commit graph from its history: the history pack
// (when compaction has made one) and the history pieces that pushes add. They
// hold only commits, about 160 bytes each, so a fetch reads them whole, in a
// request each, and walks ancestry in memory instead of reading commits one by
// one out of the big packs.
//
//   const graph = await readHistory({ store, cache, manifest });
//   graph.parents(oid)   the commit's parents, or undefined if it isn't a commit
//                        of this repository
//
// A pack is read by getting it whole and inflating its entries one after the
// other. An entry may be a delta (git sometimes deltifies commits), against
// an earlier entry of the same pack: the history packs are self-contained, as
// every pack is. What is read is held in memory, so a repository whose history
// is over `maxBytes` of packs gets null instead: the caller sends everything,
// which is slow but never wrong.
//
// The packs are immutable, so the bytes are kept in the cache by name. A miss
// is one more request.
const crypto = require("crypto");
const zlib = require("zlib");
const { packKey } = require("./layout");
const { parseHeader } = require("./pack");
const { applyDelta } = require("./delta");
const { parseCommit } = require("./objects");
const { CorruptError } = require("./errors");
const { mapLimit } = require("./limit");

const CONCURRENCY = 8;

const PACK_HEADER = 12;
const TRAILER = 20;
const MAX_ENTRY_HEADER = 32;

const MAX_BYTES = 64 * 1024 * 1024;

// The commits in a pack of commits, added to `into` (a Map of ID -> parents)
function readCommits(buffer, name, into) {
  if (buffer.length < PACK_HEADER + TRAILER || buffer.toString("latin1", 0, 4) !== "PACK" || buffer.readUInt32BE(4) !== 2) {
    throw new CorruptError(name + " is not a version 2 pack");
  }

  const count = buffer.readUInt32BE(8);
  const end = buffer.length - TRAILER;
  const byOffset = new Map();
  const byOid = new Map();
  let at = PACK_HEADER;

  for (let i = 0; i < count; i++) {
    if (at >= end) throw new CorruptError(name + " is cut short");

    const entry = parseHeader(buffer.subarray(at, Math.min(at + MAX_ENTRY_HEADER, end)), at);
    const inflated = zlib.inflateSync(buffer.subarray(at + entry.length, end), { info: true, maxOutputLength: Math.max(entry.size, 1) });
    if (inflated.buffer.length !== entry.size) throw new CorruptError(name + " has an entry that is not the size its header says");

    let object = { type: entry.type, data: inflated.buffer };
    if (entry.baseOffset !== undefined || entry.baseOid !== undefined) {
      const base = entry.baseOffset !== undefined ? byOffset.get(entry.baseOffset) : byOid.get(entry.baseOid);
      if (!base) throw new CorruptError(name + " has a delta whose base is not an earlier entry");
      object = { type: base.type, data: applyDelta(base.data, inflated.buffer) };
    }
    if (object.type !== "commit") throw new CorruptError(name + " holds something other than commits");

    const oid = crypto.createHash("sha1").update("commit " + object.data.length + "\0").update(object.data).digest("hex");
    byOffset.set(at, object);
    byOid.set(oid, object);
    into.set(oid, parseCommit(object.data).parents);

    at += entry.length + inflated.engine.bytesWritten;
  }

  if (at !== end) throw new CorruptError(name + " has more in it than its header says");
}

// A pack's bytes, from the cache if it is there
async function bytesOf({ store, cache, pack }) {
  const key = packKey(pack.name);
  const cacheKey = store.id + "/" + key;

  const cached = cache ? await cache.get(cacheKey) : null;
  if (cached && cached.length === pack.size) return cached;

  const bytes = await store.get(key, { maxBytes: pack.size });
  if (bytes.length !== pack.size) throw new CorruptError(pack.name + " is " + bytes.length + " bytes; the manifest says " + pack.size);
  if (cache) await cache.put(cacheKey, bytes);
  return bytes;
}

// Every commit of the repository's history, or null when it is too big to hold
async function readHistory({ store, cache = null, manifest, maxBytes = MAX_BYTES }) {
  const packs = [...(manifest.history ? [manifest.history] : []), ...(manifest.historyPieces || [])];
  if (packs.reduce((sum, pack) => sum + pack.size, 0) > maxBytes) return null;

  const commits = new Map();
  const sources = await mapLimit(packs, CONCURRENCY, (pack) => bytesOf({ store, cache, pack }));
  sources.forEach((bytes, index) => readCommits(bytes, packs[index].name, commits));

  return { size: commits.size, has: (oid) => commits.has(oid), parents: (oid) => commits.get(oid) };
}

module.exports = { readHistory };
