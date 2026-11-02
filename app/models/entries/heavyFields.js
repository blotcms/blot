// The large, render-only entry fields (html, body, ...) a cached read can
// leave out when its caller doesn't need them: see models/template/util/
// projectableEntryFields for why only these.
const HEAVY_FIELDS = require("models/template/util/projectableEntryFields");

// options.keep (a list of field names, or undefined for all of them) as the
// heavy fields to keep, in HEAVY_FIELDS order
function keepFields(keep) {
  return HEAVY_FIELDS.filter((field) => !keep || keep.includes(field));
}

// Deletes, in place, the heavy fields not in `keep`.
function stripHeavyFields(entries, keep) {
  const strip = HEAVY_FIELDS.filter((field) => !keep.includes(field));
  if (!strip.length) return entries;

  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    for (const field of strip) {
      if (entry[field] !== undefined) delete entry[field];
    }
  }

  return entries;
}

module.exports = { HEAVY_FIELDS, keepFields, stripHeavyFields };
