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
//                     once per host, sets absoluteURL, freezes the copy and
//                     shares it across requests; everything nested (tags,
//                     metadata, thumbnail, backlinks, formatDate helpers) is
//                     shared with the cached value, frozen by
//                     prepareCacheValue. first/last/position were set by the
//                     fill's own eachEntry walk, so loadView skips these
//                     (./sharedValues.js), and Mustache only reads.
//
// Everything augment() derives from the request must be in the cache key
// (augmentContext) or recomputed per request in shareEntries (absoluteURL).
const EntryInstance = require("models/entry/instance");
const { LRUCache } = require("lru-cache");
const augment = require("./augment");
const backlinksFor = require("./backlinks");
const eachEntry = require("./eachEntry");
const sharedValues = require("./sharedValues");
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

  let total = 0;

  req.log("Augmenting entries to cache");

  try {
    await eachEntry({ value }, (entry) => {
      total++;
      return augment(req, res, entry, backlinks);
    });
  } catch (e) {
    throw isRedisUnavailableError(e) ? e : ERROR.BAD_LOCALS();
  }

  req.log("Augmented", total, "entries to cache");

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

// Copying the catalog per request cost ~75ms plus GC on a ~1,200-entry blog,
// on every hit. absoluteURL is the only request-dependent field, so build
// the copy once per cached payload and blogURL, freeze it, and hand the same
// one to every request on that host. A blog is reachable on a handful of
// hosts (domain, www, handle subdomain, http/https); past MAX_HOSTS, copy
// per request as before rather than grow without bound.
const MAX_HOSTS = 8;
const byPayload = new WeakMap();

function shareEntries(value, blogURL) {
  if (!value || typeof value !== "object") return value;

  let byHost = byPayload.get(value);
  if (!byHost) {
    byHost = new Map();
    byPayload.set(value, byHost);
  }

  let copy = byHost.get(blogURL);
  if (!copy) {
    copy = copyForHost(value, blogURL);
    if (byHost.size < MAX_HOSTS) byHost.set(blogURL, copy);
  }

  return copy;
}

function copyForHost(value, blogURL) {
  if (Array.isArray(value)) {
    return freezeShared(value.map((item) => copyForHost(item, blogURL)));
  }

  if (value instanceof EntryInstance) {
    const entry = Object.assign(new EntryInstance(), value);

    if (entry.__augmented && typeof entry.url === "string") {
      entry.absoluteURL = augment.absoluteURL(blogURL, entry.url);
    }

    return freezeShared(entry);
  }

  if (value && typeof value === "object") {
    const copy = {};
    for (const key of Object.keys(value)) {
      copy[key] = copyForHost(value[key], blogURL);
    }
    return freezeShared(copy);
  }

  return value;
}

function freezeShared(value) {
  sharedValues.add(value);
  return Object.freeze(value);
}

module.exports = {
  augmentContext,
  augmentEntries,
  shareEntries,
  warnIfTooLargeToCache,
};
