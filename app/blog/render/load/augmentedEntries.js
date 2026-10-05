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
const augment = require("./augment");
const { createBacklinkLookups } = augment;
const eachEntry = require("./eachEntry");
const ERROR = require("../error");
const { isRedisUnavailableError } = require("helper/redisUnavailable");

// augment() reads these besides the entry itself. blogURL is deliberately
// absent - it varies with the host/protocol a request arrived on, so keying
// on it would store one copy of the catalog per hostname.
function augmentContext(req, res) {
  const locals = (res && res.locals) || {};
  return {
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
// project (optional) trims each backlinked entry the way the list's own
// entries were trimmed, so a template that never reads html (say) doesn't
// pay to keep it for every entry a post links to.
async function augmentEntries(req, res, value, project) {
  const stats = {
    backlinkErrors: 0,
    backlinkLookups: createBacklinkLookups(project),
  };

  try {
    await eachEntry({ value }, (entry) => augment(req, res, entry, stats));
  } catch (e) {
    throw isRedisUnavailableError(e) ? e : ERROR.BAD_LOCALS();
  }

  // The lookups hold every backlinked entry; the caller only needs the counts.
  delete stats.backlinkLookups;

  return stats;
}

// A backlink lookup that hit a Redis error resolved to nothing, same as a
// link to a missing entry. Render with what we have, but don't cache it -
// the gap would otherwise persist until the next cacheID change.
function backlinksIncomplete(stats) {
  return stats.backlinkErrors > 0;
}

// An LRU silently refuses to store a value over its byte cap, which looks
// identical to a cache that works until every request pays for a full fill
// (see archives.js and all_entries.js). Say so, once per fill.
function warnIfTooLargeToCache(name, req, prepared, cache) {
  if (prepared.size <= cache.maxSize) return;

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
  backlinksIncomplete,
  shareEntries,
  warnIfTooLargeToCache,
};
