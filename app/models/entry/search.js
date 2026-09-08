const ensure = require("helper/ensure");
const client = require("models/client");
const { promisify } = require("util");
const { sortEntries } = require("blog/sortOptions");
const metadataCaseInsensitive = require("helper/metadataCaseInsensitive");
const get = promisify((blogID, entryIDs, callback) =>
  require("./get")(blogID, entryIDs, function (entries) {
    callback(null, entries);
  })
);

const TIMEOUT = 8000;
const MAX_RESULTS = 25;
// The caller sorts the result, so we can't stop at the first MAX_RESULTS
// matches in Redis scan order — collect a wider pool (capped here and by the
// timeout) so the sorted first page is right. Beyond this it stays best-effort.
const MAX_COLLECT = 500;
const CHUNK_SIZE = 200;

function buildSearchText(entry) {
  return [
    entry.title,
    entry.permalink,
    entry.tags.join(" "),
    entry.path,
    entry.html,
    Object.values(entry.metadata).join(" ")
  ].join(" ").toLowerCase();
}

function isSearchable(entry) {
  const metadataByLowercaseKey = metadataCaseInsensitive(entry.metadata);

  if (entry.deleted || entry.draft) return false;
  if (entry.page && (!metadataByLowercaseKey.search || isFalsy(metadataByLowercaseKey.search))) return false;
  if (metadataByLowercaseKey.search && isFalsy(metadataByLowercaseKey.search)) return false;
  return true;
}

function isFalsy(value) {
  value = value.toString().toLowerCase().trim();
  return value === "false" || value === "no" || value === "0";
}

module.exports = async function (blogID, query, options, callback) {
  if (typeof options === "function") {
    callback = options;
    options = {};
  }
  options = options || {};

  ensure(blogID, "string").and(query, "string").and(callback, "function");

  const terms = query.split(/\s+/)
    .map(term => term.trim().toLowerCase())
    .filter(Boolean);

  if (!terms.length) {
    return callback(null, []);
  }

  // Callers always order the result (blog/sortOptions.js normalises a missing
  // selection to newest-first date), so stopping at the first MAX_RESULTS
  // matches in Redis scan order could drop newer entries. Collect the wider
  // candidate pool (bounded by MAX_COLLECT and the timeout), then sort + cap.
  const startTime = Date.now();
  const timedOut = () => Date.now() - startTime > TIMEOUT;
  const results = [];

  const isMatch = entry => {
    if (!isSearchable(entry)) return false;
    const text = buildSearchText(entry);
    return terms.length === 1
      ? text.includes(terms[0])
      : terms.every(term => text.includes(term));
  };

  const scanList = async key => {
    let cursor = "0";
    do {
      if (timedOut() || results.length >= MAX_COLLECT) return;

      const scanned = await client.zScan(key, cursor, { COUNT: CHUNK_SIZE });
      cursor = String(scanned.cursor);

      const ids = (scanned.members || []).map(member => member.value);
      if (!ids.length) continue;

      for (const entry of await get(blogID, ids)) {
        if (isMatch(entry)) results.push(entry);
        if (results.length >= MAX_COLLECT || timedOut()) return;
      }
    } while (cursor !== "0");
  };

  try {
    // The 'entries' list (rather than 'all') skips deleted entries; the 'pages'
    // list picks up any pages opted into search via metadata.
    await scanList("blog:" + blogID + ":entries");
    await scanList("blog:" + blogID + ":pages");

    return callback(null, sortEntries(results, options).slice(0, MAX_RESULTS));
  } catch (error) {
    return callback(error);
  }
};
