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
//
// The packs themselves are a second, lower-priority phase (served/warm.js),
// one pack at a time: packList(manifest) lists them newest first and
// warmPack({ store, cache, pack }) streams one into the cache through
// keepPack, as the writers do, so the copy is exactly what clone and pack.js
// read; its memory does not depend on the pack's size.
const { Readable } = require("stream");
const manifest = require("./manifest");
const { chooseWhole, loadWhole, wholeKey } = require("./idx");
const { idxKey, packKey, manifestKey } = require("./layout");
const { cacheKeyOf, keepPack, CACHE_SHARE } = require("./packcache");
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

// Every pack the manifest names (live packs, the history pack and its
// pieces), newest first by the swap which added it, as { name, size, seq }
function packList(m) {
  const all = [
    ...m.packs.map((pack) => ({ name: pack.name, size: pack.size, seq: pack.seq || 0 })),
    ...(m.historyPieces || []).map((pack) => ({ name: pack.name, size: pack.size, seq: pack.seq || 0 })),
    ...(m.history ? [{ name: m.history.name, size: m.history.size, seq: m.history.through || 0 }] : []),
  ];
  const seen = new Set();
  return all.filter((pack) => !seen.has(pack.name) && seen.add(pack.name)).sort((a, b) => b.seq - a.seq);
}

// When the repository's newest manifest was written, by the store's clock
// (0 if it cannot be said): how recently it was pushed to or written by Blot
async function lastWritten(store, m) {
  try {
    const head = await store.head(manifestKey(m.seq));
    return (head && head.lastModified) || 0;
  } catch (err) {
    return 0;
  }
}

// Streams one pack into the cache. Resolves "cached" (already there at the
// right size), "fetched", "skipped" (too big for the cache to keep a copy of),
// "declined" (the cache would not take it) or "failed" (the download did).
//
// `bytesPerSecond` caps the download's rate, and `between()` (awaited between
// chunks) lets the caller hold it back while the host is busy.
async function* paced(source, { bytesPerSecond = Infinity, between = null }) {
  const started = Date.now();
  let sent = 0;
  for await (const chunk of source) {
    if (between) await between();
    yield chunk;
    sent += chunk.length;
    if (bytesPerSecond < Infinity) {
      const wait = (sent / bytesPerSecond) * 1000 - (Date.now() - started);
      if (wait > 1) await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}

async function warmPack({ store, cache, pack, bytesPerSecond = Infinity, between = null }) {
  const key = cacheKeyOf(store, pack.name);
  if ((await cache.size(key)) === pack.size) return "cached";
  if (pack.size > Math.floor(cache.maxBytes / CACHE_SHARE)) return "skipped";

  const declined = cache.stats().declined;
  let source;
  let stream;
  try {
    source = store.stream(packKey(pack.name));
    stream = source;
    if (bytesPerSecond < Infinity || between) stream = Readable.from(paced(source, { bytesPerSecond, between }), { objectMode: false });
  } catch (err) {
    if (source && typeof source.destroy === "function") source.destroy();
    return "failed";
  }
  try {
    const kept = await keepPack({ cache, store, name: pack.name, size: pack.size, stream });
    if (kept) return "fetched";
    return cache.stats().declined > declined ? "declined" : "failed";
  } finally {
    // The wrapper may have been abandoned before it read anything, which
    // leaves the download open: close it whatever happened
    if (typeof source.destroy === "function") source.destroy();
  }
}

module.exports = { warmRepo, packList, lastWritten, warmPack };
