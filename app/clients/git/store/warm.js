// Fills the cache with what the next push, commit, clone or fetch of a
// repository reads first, for a host which has just started: the whole
// indexes of its packs (those idx.js reads whole, within its budget) and its
// history pack and pieces (what history.js reads whole). What the cache
// already holds is not fetched again, so warming a warm cache costs only the
// manifest read.
//
//   warmRepo({ store, cache, manifest?, maxBytes? })
//     resolves { fetched, cached, bytes, full }: files fetched and put in the
//     cache, files it already held, the bytes fetched, and whether it stopped
//     because the cache would take no more or `maxBytes` (what this call may
//     fetch) ran out
//
// It never throws for a file it could not fetch or keep; it moves on.
const manifest = require("./manifest");
const { chooseWhole, loadWhole, wholeKey } = require("./idx");
const { idxKey, packKey } = require("./layout");
const { cacheKeyOf } = require("./packcache");
const { mapLimit } = require("./limit");

const CONCURRENCY = 4;

// What history.js will read at most
const MAX_HISTORY = 64 * 1024 * 1024;

async function warmRepo({ store, cache, manifest: current = null, maxBytes = Infinity }) {
  const m = current || (await manifest.read(store));
  const result = { fetched: 0, cached: 0, bytes: 0, full: false };

  const files = [];
  const whole = chooseWhole(m.packs, cache);
  for (const pack of m.packs) {
    if (whole.has(pack.name)) files.push({ cacheKey: wholeKey(store.id, idxKey(pack.name)), size: pack.idxSize, fetch: () => loadWhole({ store, key: idxKey(pack.name), size: pack.idxSize, cache, namespace: store.id }) });
  }
  const history = [...(m.history ? [m.history] : []), ...(m.historyPieces || [])];
  if (history.reduce((sum, pack) => sum + pack.size, 0) <= MAX_HISTORY) {
    for (const pack of history) {
      files.push({
        cacheKey: cacheKeyOf(store, pack.name),
        size: pack.size,
        fetch: async () => {
          const bytes = await store.get(packKey(pack.name), { maxBytes: pack.size });
          if (bytes.length === pack.size) await cache.put(cacheKeyOf(store, pack.name), bytes);
        },
      });
    }
  }

  await mapLimit(files, CONCURRENCY, async (file) => {
    if (result.full) return;
    if ((await cache.size(file.cacheKey)) === file.size) {
      result.cached++;
      return;
    }
    if (result.bytes + file.size > maxBytes) {
      result.full = true;
      return;
    }
    result.bytes += file.size;
    try {
      await file.fetch();
    } catch (err) {
      return;
    }
    if ((await cache.size(file.cacheKey)) === file.size) result.fetched++;
    else result.full = true;
  });

  return result;
}

module.exports = { warmRepo };
