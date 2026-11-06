// A pack's bytes kept whole in the cache (cache.js), by the pack's name.
//
// Packs are named by their checksum and never change, so a copy in the cache
// is good for as long as it lasts, on any host, whichever manifest names the
// pack. The writers put the packs they have just made there as they upload
// them (receive, commit, compaction, import: keepPack), so the next clone or
// fetch of a new push, and the next reader of its objects, reads the local
// copy and asks the store for nothing (packSource). History packs and pieces
// are kept under the same key, which history.js reads whole.
//
// Keeping a pack never fails what kept it: a pack bigger than an eighth of the
// cache, or one the cache has no room for, is skipped.
const fs = require("fs");
const { packKey } = require("./layout");

const CACHE_SHARE = 8;

const cacheKeyOf = (store, name) => store.id + "/" + packKey(name);

function keeps(cache, size) {
  return !!cache && typeof cache.putStream === "function" && size <= Math.floor(cache.maxBytes / CACHE_SHARE);
}

// Puts the bytes of pack `name` (`size` bytes) in the cache, from a Buffer,
// a file, or a stream of it. Resolves true if they were kept; never rejects.
// A stream given is consumed or destroyed.
async function keepPack({ cache, store, name, size, buffer = null, file = null, stream = null }) {
  if (!keeps(cache, size)) {
    if (stream && typeof stream.destroy === "function") stream.destroy();
    return false;
  }
  try {
    if (buffer) return buffer.length === size && (await cache.put(cacheKeyOf(store, name), buffer));
    const source = stream || fs.createReadStream(file);
    if (typeof source.on === "function") source.on("error", () => {});
    return await cache.putStream(cacheKeyOf(store, name), source, size);
  } catch (err) {
    return false;
  }
}

// Reads ranges of pack `name` (`size` bytes, as the manifest says) from the
// cache's copy when there is a whole one of that size, and from the store
// otherwise. `local()` resolves whether the cache has it (looked at once);
// a copy which goes away (evicted, or deleted by another process) or turns
// out damaged is a miss, and from then on the store is read.
function packSource({ cache, store, name, size }) {
  const key = packKey(name);
  let local = cache && typeof cache.read === "function" ? null : Promise.resolve(false);

  function isLocal() {
    if (!local) local = cache.size(cacheKeyOf(store, name)).then((length) => length === size, () => false);
    return local;
  }

  async function read(offset, length) {
    if (await isLocal()) {
      const bytes = await cache.read(cacheKeyOf(store, name), offset, length).catch(() => null);
      if (bytes) return bytes;
      local = Promise.resolve(false);
    }
    return store.read(key, offset, length);
  }

  return { read, local: isLocal };
}

module.exports = { keepPack, packSource, cacheKeyOf, CACHE_SHARE };
