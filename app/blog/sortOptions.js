// Shared helpers for the dashboard "Post sorting" control.
//
// The control offers four selections; normalised they are:
//
//   date + asc  -> newest first   (dateStamp descending)
//   date + desc -> oldest first   (dateStamp ascending)
//   id   + asc  -> file path A-Z  (id ascending)
//   id   + desc -> file path Z-A  (id descending)
//
// The "date + asc = newest first" inversion matches models/entries, where
// sort_order "asc" reads the dateStamp-scored set in reverse.

// Read the selection from a template's locals. Accepts the flat
// sort_by / sort_order pair or a nested sort: { by, direction | order }.
function getTemplateSortOptions(locals) {
  const sort = locals?.sort;

  return {
    sortBy: sort?.by ?? locals?.sort_by,
    order: sort?.direction ?? sort?.order ?? locals?.sort_order,
  };
}

function normalize(sortOptions) {
  return {
    by: sortOptions?.sortBy === "id" ? "id" : "date",
    direction: sortOptions?.order === "desc" ? "desc" : "asc",
  };
}

function compareStrings(a, b) {
  a = a == null ? "" : String(a);
  b = b == null ? "" : String(b);
  return a < b ? -1 : a > b ? 1 : 0;
}

// Comparator for hydrated entry objects ({ id, dateStamp }).
function compareEntries(sortOptions) {
  const { by, direction } = normalize(sortOptions);
  const sign = direction === "desc" ? -1 : 1;

  if (by === "id") return (a, b) => sign * compareStrings(a && a.id, b && b.id);

  // "asc" means newest first, so the base comparison is dateStamp descending.
  // Equal timestamps fall back to descending id, matching how Redis ZRANGE REV
  // breaks score ties for the regular listing; `sign` flips both for oldest-first.
  const stamp = (entry) => (entry && entry.dateStamp) || 0;
  return (a, b) => {
    const byDate = stamp(b) - stamp(a);
    if (byDate !== 0) return sign * byDate;
    return sign * -compareStrings(a && a.id, b && b.id);
  };
}

// Return a new array of hydrated entries in the selected order.
function sortEntries(entries, sortOptions) {
  return (entries || []).slice().sort(compareEntries(sortOptions));
}

// Order a list of entry IDs that arrived newest-first (e.g. a tag's
// dateStamp-scored set). Only IDs are available, so date order is taken from
// the incoming order rather than a dateStamp.
function sortEntryIDs(entryIDs, sortOptions) {
  const { by, direction } = normalize(sortOptions);
  const ids = (entryIDs || []).slice();

  if (by === "id") {
    ids.sort();
    if (direction === "desc") ids.reverse();
    return ids;
  }

  if (direction === "desc") ids.reverse(); // newest-first -> oldest-first
  return ids;
}

// True when the selection is the natural newest-first order that tag sets and
// the recent-entries list already return, so no reordering is needed.
function isNewestFirst(sortOptions) {
  const { by, direction } = normalize(sortOptions);
  return by === "date" && direction === "asc";
}

module.exports = getTemplateSortOptions;
module.exports.getTemplateSortOptions = getTemplateSortOptions;
module.exports.compareEntries = compareEntries;
module.exports.sortEntries = sortEntries;
module.exports.sortEntryIDs = sortEntryIDs;
module.exports.isNewestFirst = isNewestFirst;
