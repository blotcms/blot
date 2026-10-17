const { fetchMetadata } = require("./remote");
const { getCachePath, readCache, writeCache } = require("./cache");
const { sanitizeMetadata, fallbackMetadata } = require("./metadata");
const { ensureThumbnails } = require("./thumbnails");
const { ensureIcon } = require("./icons");
const { NEGATIVE_CACHE_TTL, POSITIVE_CACHE_TTL } = require("./constants");

async function loadMetadata(href, blogID, transformers = {}) {
  if (!href) return null;

  const cachePath = getCachePath(blogID, href);
  const cached = await readCache(cachePath);

  if (cached && cached.fallback) {
    // Negative cache entry from a previous failed lookup. Keep serving the
    // hostname-only card until it expires rather than re-hitting the network
    // on every rebuild.
    if (isFresh(cached, NEGATIVE_CACHE_TTL)) {
      return fallbackMetadata(href);
    }
  } else if (cached) {
    // Positive entry: serve it while fresh, otherwise re-validate against the
    // target page (fetchMetadata itself hits the transformer cache, so this
    // is cheap) and fall back to the stale entry if that fetch fails.
    if (isFresh(cached, POSITIVE_CACHE_TTL)) {
      return hydrate(cached, href, blogID, transformers, cachePath);
    }

    const refreshed = await fetchMetadata(href, transformers.html);
    if (refreshed) {
      return store(refreshed, href, blogID, transformers, cachePath);
    }

    return hydrate(cached, href, blogID, transformers, cachePath);
  }

  const fetched = await fetchMetadata(href, transformers.html);
  if (fetched) {
    return store(fetched, href, blogID, transformers, cachePath);
  }

  const fallback = fallbackMetadata(href);
  if (fallback) {
    await writeCache(cachePath, { fallback: true, cachedAt: Date.now() });
    return fallback;
  }

  return null;
}

// Resolve thumbnail/icon paths for a metadata object and persist it. Does not
// touch cachedAt, so a served-from-cache entry keeps ageing from its original
// fetch rather than being refreshed on every build.
async function hydrate(metadata, href, blogID, transformers, cachePath) {
  sanitizeMetadata(metadata, href);
  metadata.url = href;
  await ensureThumbnails(metadata, blogID, transformers.image);
  await ensureIcon(metadata, blogID);
  await writeCache(cachePath, metadata);
  return metadata;
}

// hydrate() for a freshly fetched result: stamp the fetch time so the
// positive-cache TTL is measured from now.
async function store(metadata, href, blogID, transformers, cachePath) {
  metadata.cachedAt = Date.now();
  return hydrate(metadata, href, blogID, transformers, cachePath);
}

function isFresh(cached, ttl) {
  const cachedAt = Number(cached && cached.cachedAt);
  if (!Number.isFinite(cachedAt)) return false;
  return Date.now() - cachedAt < ttl;
}

module.exports = {
  loadMetadata,
};
