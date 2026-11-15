// Gives a page of entries its pagination in the forms templates read:
//
// - list.pagination, as {{#posts.pagination}} after the list: the documented
//   form, one per list, so a page can show several lists. Not enumerable, so
//   it stays out of JSON and for...in; Mustache's dotted lookup still finds it.
// - the last entry's pagination, the older {{#posts}}{{#pagination}} form.
//   Every other entry gets pagination: null, so inside the list Mustache stops
//   at the entry instead of falling through to the top-level pagination and
//   rendering it after every entry.
//
// Call it on the copy that will be rendered: a cache that clones the array
// drops the property, and so does helper/extend, which rebuilds arrays when
// render/middleware.js merges the retrieved locals (carryListPagination puts
// it back).
function setListPagination(entries, pagination) {
  Object.defineProperty(entries, "pagination", {
    value: pagination,
    enumerable: false,
    writable: true,
    configurable: true,
  });
}

function listPagination(entries, pagination) {
  if (!Array.isArray(entries)) return entries;

  const last = entries.length - 1;

  entries.forEach((entry, i) => {
    if (entry && typeof entry === "object")
      entry.pagination = i === last ? pagination : null;
  });

  setListPagination(entries, pagination);

  return entries;
}

// After merging retrieved locals into res.locals, give each merged array the
// pagination its retrieved array carried.
function carryListPagination(locals, retrieved) {
  if (!locals || !retrieved) return;

  for (const name of Object.keys(retrieved)) {
    const from = retrieved[name];
    const to = locals[name];
    if (
      Array.isArray(from) &&
      Array.isArray(to) &&
      to !== from &&
      Object.prototype.hasOwnProperty.call(from, "pagination")
    )
      setListPagination(to, from.pagination);
  }
}

module.exports = listPagination;
module.exports.carryListPagination = carryListPagination;
