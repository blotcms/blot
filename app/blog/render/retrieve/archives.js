const getAllCached = require("./helpers/getAllCached");
const yieldToEventLoop = require("./helpers/yieldToEventLoop");
const arrayify = require("helper/arrayify");
const projectEntryFields = require("./helpers/projectEntryFields");
const moment = require("moment");
require("moment-timezone");
const asRetriever = require("../../lib/asRetriever");
const LRUCache = require("lru-cache").LRUCache;
const { prepareCacheValue } = require("../../lib/clone");
const cacheStats = require("../../lib/cacheStats");
const fetchCached = require("../../lib/fetchCached");
const { Uncacheable } = require("../../lib/uncacheableFetch");
const {
  augmentContext,
  augmentEntries,
  shareEntries,
  warnIfTooLargeToCache,
} = require("../load/augmentedEntries");

const ALIASES = getAllCached.ALIASES.archives;

// Caches the year/month grouping itself (already trimmed to only the fields
// this template's archives view references, and already augmented), not
// just the raw entry list - so repeat renders skip the Redis fetch, the
// grouping work, the deep clone and augment() for every entry (see
// render/load/augmentedEntries.js), and don't pay to store entry bodies a
// sitemap/archive view never reads.
const archivesCache = new LRUCache({
  max: 200,
  maxSize: 100 * 1024 * 1024,
  sizeCalculation: (value) => value.size,
  // See tagged.js: let an in-flight fill evicted under size pressure still
  // hand its result to every request coalesced onto it.
  ignoreFetchAbort: true,
  // Coalesce concurrent misses on the same key into one fill.
  fetchMethod: async (key, staleValue, { context }) => {
    const { req, res } = context;
    const years = await buildArchives(req, req.blog);
    await yieldToEventLoop();
    // Backlinked entries are trimmed like the list's own.
    const backlinksFailed = await augmentEntries(req, res, years, ALIASES);
    await yieldToEventLoop();
    const prepared = prepareCacheValue(years, { preserveEntryInstances: true });
    warnIfTooLargeToCache("archives", req, prepared, archivesCache);

    // Don't cache an empty result: getAllCached already declines to persist
    // a [] catalog (which Entries.getAll also returns on a transient Redis
    // failure, not just for a genuinely empty blog), but a non-empty catalog
    // could still group into zero years if every entry lacked a dateStamp -
    // guard here too so archivesCache can't end up caching that either.
    if (years.length === 0 || backlinksFailed) {
      throw new Uncacheable(prepared);
    }

    return prepared;
  },
});

// null means "no projection metadata" - see all_entries.js for why that has
// to be part of the cache key rather than just skipping projection.
function fieldsSignature(retrieve) {
  const fields = projectEntryFields.resolveFields(retrieve, ALIASES);
  return fields ? Object.keys(fields).sort().join(",") : null;
}

function createCacheKey(blog, retrieve, context) {
  return JSON.stringify({
    blogID: String(blog && blog.id),
    cacheID: String(blog && blog.cacheID),
    // The year/month buckets are computed from entry.dateStamp converted
    // into the blog's timezone, so a timezone change must bust the cache too.
    timeZone: String(blog && blog.timeZone),
    fields: fieldsSignature(retrieve),
    augment: context,
  });
}

function buildYears(allEntries, timeZone) {
  const years = {};

  for (const x in allEntries) {
    const entry = allEntries[x];

    const date = moment.utc(entry.dateStamp).tz(timeZone);

    const year = date.format("YYYY");
    const month = date.format("MMMM");

    years[year] = years[year] || {
      year: year,
      total: 0,
      months: {},
    };

    years[year].months[month] = years[year].months[month] || {
      month: month,
      entries: [],
    };

    years[year].months[month].entries.push(entry);
    years[year].total++;
  }

  for (const i in years) {
    for (const j in years[i].months)
      years[i].months[j].s = years[i].months[j].entries.length > 1 ? "s" : "";

    years[i].months = arrayify(years[i].months);
    years[i].s = years[i].total > 1 ? "s" : "";
  }

  return arrayify(years).sort(function (a, b) {
    return parseInt(b.year) - parseInt(a.year);
  });
}

function flattenEntries(years) {
  const entries = [];

  for (const year of years) {
    for (const month of year.months) {
      for (const entry of month.entries) entries.push(entry);
    }
  }

  return entries;
}

async function buildArchives(req, blog, options) {
  const allEntries = await getAllCached(blog, {
    ...options,
    retrieve: req.retrieve,
    log: req.log,
  });
  const years = buildYears(allEntries, blog.timeZone);

  // Strip heavy fields the current template doesn't reference before the
  // grouped result is returned (dateStamp is always kept, so the year/month
  // grouping above is unaffected).
  projectEntryFields(flattenEntries(years), req.retrieve, ALIASES);

  return years;
}

function blogURL(req) {
  return (req.blog && req.blog.locals && req.blog.locals.blogURL) || "";
}

async function archives(req, res) {
  // Preview renders change on every save and are rarely repeated, so caching
  // them would only thrash the LRU with entries no other request will read.
  // render/load augments these the usual way.
  if (req.preview) {
    return buildArchives(req, req.blog, { bypassCache: true });
  }

  const key = createCacheKey(req.blog, req.retrieve, augmentContext(req, res));

  let prepared;
  try {
    prepared = await fetchCached(archivesCache, "archives", req.log, key, {
      context: { req, res },
    });
  } catch (e) {
    if (!(e instanceof Uncacheable)) throw e;
    prepared = e.payload;
  }

  return shareEntries(prepared.payload, blogURL(req));
}

module.exports = asRetriever(archives);
module.exports._createCacheKey = createCacheKey;
module.exports._clear = function () {
  archivesCache.clear();
};
module.exports._stats = cacheStats("archives", archivesCache);
