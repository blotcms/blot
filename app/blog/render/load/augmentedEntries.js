// Catalog-sized locals (allEntries, archives) hold every entry on the blog.
// Deep-cloning that list out of the LRU and re-running augment() on every
// entry for every render cost ~1s of blocked event loop and a full copy of
// the catalog per request on a ~900-post blog, plus two Redis round trips
// and a full entry JSON.parse per backlink - so a handful of concurrent
// renders was enough to exhaust the heap. Instead, those retrievers cache
// the entries already augmented and hand each request a shallow copy:
//
//   augmentEntries()  runs once per cache fill, via the same walk loadView
//                     uses, so render-time augment() later skips these
//                     entries (entry.__augmented).
//   shareEntries()    copies the containers and each Entry's own properties
//                     but shares everything nested (tags, metadata,
//                     thumbnail, backlinks, formatDate helpers). Those are
//                     frozen by prepareCacheValue; nothing downstream writes
//                     to them - loadView's list() only sets first/last/
//                     position on the fresh copies, and Mustache only reads.
//
// Everything augment() derives from the request must be in the cache key
// (augmentContext) or recomputed per request in shareEntries (absoluteURL).
const EntryInstance = require("models/entry/instance");
const { LRUCache } = require("lru-cache");
const augment = require("./augment");
const backlinksFor = require("./backlinks");
const eachEntry = require("./eachEntry");
const ERROR = require("../error");
const { isRedisUnavailableError } = require("helper/redisUnavailable");
const projectEntryFields = require("../retrieve/helpers/projectEntryFields");

// augment() reads these besides the entry itself. blogURL is deliberately
// absent - it varies with the host/protocol a request arrived on, so keying
// on it would store one copy of the catalog per hostname.
function augmentContext(req, res) {
  const locals = (res && res.locals) || {};
  return {
    backlinks: backlinksFor.isNeeded(req),
    timeZone: String(req.blog && req.blog.timeZone),
    hideDates: locals.hide_dates || false,
    dateDisplay: locals.date_display || "MMMM D, Y",
  };
}

// Called from a retriever, where a thrown error would be logged and the
// local silently dropped from an otherwise successful (and proxy-cacheable)
// page. Convert failures the same way loadView's caller does, so a malformed
// entry still renders the template error page - retrieve() rethrows these.
//
// aliases (optional) are the retrieve aliases the list was projected under;
// each backlinked entry is trimmed the same way, so a template that never
// reads html (say) doesn't pay to keep it for every entry a post links to.
//
// Resolves to whether any backlink lookup failed (see ./backlinks.js): a
// caller caching the result should decline to. The augmented entries have
// rendered, just without the backlinks that couldn't be read.
async function augmentEntries(req, res, value, aliases) {
  const project = aliases
    ? (entry) => projectEntryFields(entry, req.retrieve, aliases)
    : undefined;
  const backlinks = backlinksFor(req, { project });

  try {
    await eachEntry({ value }, (entry) => augment(req, res, entry, backlinks));
  } catch (e) {
    throw isRedisUnavailableError(e) ? e : ERROR.BAD_LOCALS();
  }

  return backlinks.failed;
}

// An LRU silently refuses to store a value over its byte cap, which looks
// identical to a cache that works until every request pays for a full fill
// (see archives.js and all_entries.js). Say so - once per blog and cacheID,
// since the result is rebuilt on every request until the next change.
const warned = new LRUCache({ max: 1000 });

function warnIfTooLargeToCache(name, req, prepared, cache) {
  if (prepared.size <= cache.maxSize) return;

  const key = JSON.stringify([
    name,
    String(req.blog && req.blog.id),
    String(req.blog && req.blog.cacheID),
  ]);
  if (warned.has(key)) return;
  warned.set(key, true);

  console.warn(
    `${name} cache: result for blog ${req.blog && req.blog.id} is ` +
      `${Math.round(prepared.size / 1024 / 1024)}MB, over the ` +
      `${Math.round(cache.maxSize / 1024 / 1024)}MB cap, so it is not cached ` +
      `and every request rebuilds it`
  );
}

function shareEntries(value, blogURL) {
  if (Array.isArray(value)) {
    return value.map((item) => shareEntries(item, blogURL));
  }

  if (value instanceof EntryInstance) {
    const entry = Object.assign(new EntryInstance(), value);

    if (entry.__augmented && typeof entry.url === "string") {
      entry.absoluteURL = augment.absoluteURL(blogURL, entry.url);
    }

    return entry;
  }

  if (value && typeof value === "object") {
    const copy = {};
    for (const key of Object.keys(value)) {
      copy[key] = shareEntries(value[key], blogURL);
    }
    return copy;
  }

  return value;
}

module.exports = {
  augmentContext,
  augmentEntries,
  shareEntries,
  warnIfTooLargeToCache,
};
