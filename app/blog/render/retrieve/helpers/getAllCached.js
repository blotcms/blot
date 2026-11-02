// The entry catalog for archives.js and all_entries.js, from
// Entries.getCatalog (models/entries/catalog.js), which caches it per blog
// cacheID. This decides which heavy fields the request's view needs, so
// both locals share one copy that keeps only those.
const Entries = require("models/entries");
const projectEntryFields = require("./projectEntryFields");

const { HEAVY_FIELDS, resolveFields } = projectEntryFields;

// The retrieve aliases of the locals this catalog fills. all_entries.js and
// archives.js project with these same lists.
const ALIASES = {
  allEntries: ["allEntries", "all_entries"],
  archives: ["archives"],
};

// The heavy fields the catalog must keep for this request: those either
// local references, across both, so that a view using allEntries and
// archives shares one copy. Every heavy field when a referenced local has no
// fields map (projectEntryFields would then strip nothing), and when neither
// local is referenced at all, so a caller without retrieve metadata gets the
// full catalog. Always in HEAVY_FIELDS order.
function heavyFieldsToKeep(retrieve) {
  const keep = new Set();
  let referenced = false;

  for (const aliases of Object.values(ALIASES)) {
    if (!retrieve || !aliases.some((alias) => retrieve[alias] !== undefined)) {
      continue;
    }

    referenced = true;

    const fields = resolveFields(retrieve, aliases);
    if (!fields) return HEAVY_FIELDS.slice();

    for (const field of HEAVY_FIELDS) if (fields[field]) keep.add(field);
  }

  if (!referenced) return HEAVY_FIELDS.slice();

  return HEAVY_FIELDS.filter((field) => keep.has(field));
}

// options.retrieve: the request's retrieve metadata, which decides the heavy
// fields kept (see heavyFieldsToKeep). Without it the catalog is complete.
// options.log: req.log, told how the lookup was served.
function getAllCached(blog, options) {
  return Entries.getCatalog(blog.id, {
    keep: heavyFieldsToKeep(options && options.retrieve),
    cacheID: blog.cacheID,
    log: options && options.log,
  });
}

module.exports = getAllCached;
module.exports.ALIASES = ALIASES;
module.exports._heavyFieldsToKeep = heavyFieldsToKeep;
