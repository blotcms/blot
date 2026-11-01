// What an operation needs to read one repository at one manifest: the store's
// reader over the live packs, with an object cache for the small objects
// (commits and trees) that tree walks read again and again.
const { createReader } = require("../../../../app/clients/git/store");
const withPrefetch = require("./prefetch");

// Objects bigger than this are not worth a cache entry
const CACHE_MAX = 256 * 1024;

function openRepo({ store, cache, manifest, limitSeq = Infinity }) {
  // `limitSeq` shows the repository as it was after that push, which lets a
  // run act as a client which is some pushes behind
  const packs = manifest.packs.filter((p) => p.seq <= limitSeq);
  const batched = withPrefetch(store);
  const reader = createReader({ store: batched, cache, packs });
  const seqOfPack = new Map(packs.map((p) => [p.name, p.seq]));
  const stats = { objectHits: 0, objectReads: 0 };

  async function read(oid) {
    const key = store.id + "/obj/" + oid;
    const hit = cache && (await cache.get(key));
    if (hit && hit.length > 0) {
      // the type is the first byte of what is cached
      stats.objectHits++;
      return { type: ["", "commit", "tree", "blob", "tag"][hit[0]], data: hit.subarray(1) };
    }
    const found = await reader.read(oid);
    if (!found) return null;
    stats.objectReads++;
    if (cache && found.data.length <= CACHE_MAX) {
      await cache.put(key, Buffer.concat([Buffer.from([{ commit: 1, tree: 2, blob: 3, tag: 4 }[found.type]]), found.data]));
    }
    return { type: found.type, data: found.data };
  }

  async function seqOf(oid) {
    const at = await reader.locate(oid);
    return at ? seqOfPack.get(at.pack.name) : null;
  }

  // Reads the entries of `oids` which are not already cached in as few
  // requests as possible; the reads which follow find them in memory
  async function prefetch(oids) {
    const missing = [];
    for (const oid of new Set(oids)) {
      if (!(cache && (await cache.get(store.id + "/obj/" + oid)))) missing.push(oid);
    }
    if (missing.length) await batched.prefetch(reader, missing);
  }

  return { reader, read, seqOf, prefetch, forget: batched.forget, packs, stats, manifest: { ...manifest, packs } };
}

module.exports = openRepo;
