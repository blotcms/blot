const config = require("config");

// A list fetch narrowed to the referenced fields (see entryFieldList) drops
// the heavy fields the template does not render. But renderLocals re-evaluates
// every string in a local as Mustache against the whole local, so an entry
// whose own retained content contains "{{...}}" can reference a heavy field
// we skipped. projectEntryFields cancels projection when it spots this, but
// it cannot restore fields that were never fetched, so we refetch the whole
// list instead.
//
// Only relevant once config.redis.readEntriesFromHash is on; until then the
// "narrow" fetch already returns whole entries and this is a straight
// pass-through with no extra round trip.
module.exports = async function withEntryFields(narrowFetch, fullFetch) {
  if (!config.redis.readEntriesFromHash) {
    return narrowFetch();
  }

  const entries = await narrowFetch();
  if (hasMustache(entries)) return fullFetch();
  return entries;
};

// True if any string field of any entry contains a Mustache tag.
function hasMustache(entries) {
  const list = Array.isArray(entries) ? entries : entries ? [entries] : [];

  for (let i = 0; i < list.length; i++) {
    const entry = list[i];
    if (!entry || typeof entry !== "object") continue;

    for (const key in entry) {
      if (!Object.prototype.hasOwnProperty.call(entry, key)) continue;
      const value = entry[key];
      if (typeof value === "string" && value.indexOf("{{") !== -1) return true;
    }
  }

  return false;
}

module.exports.hasMustache = hasMustache;
