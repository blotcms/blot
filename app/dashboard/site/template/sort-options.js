// The four choices offered by the "Post sorting" control. `value` is the
// composite the <select> posts; `sort_by` / `sort_order` are the locals stored
// on the template.
//
// Date sorting in models/entries inverts typical asc/desc: sort_order "asc" is
// newest-first, "desc" is oldest-first. Path sorting is lexicographic: "asc" is
// A–Z, "desc" is Z–A.
const OPTIONS = [
  { label: "Publish date - Newest first", sort_by: "date", sort_order: "asc", value: "date_asc" },
  { label: "Publish date - Oldest first", sort_by: "date", sort_order: "desc", value: "date_desc" },
  { label: "File path - A to Z", sort_by: "id", sort_order: "asc", value: "id_asc" },
  { label: "File path - Z to A", sort_by: "id", sort_order: "desc", value: "id_desc" }
];

const DEFAULT = { sort_by: "date", sort_order: "asc" };

const DEFAULT_OPTION = OPTIONS.find(
  option =>
    option.sort_by === DEFAULT.sort_by && option.sort_order === DEFAULT.sort_order
);

// Resolve a composite `value` ("date_asc") or a { sort_by, sort_order } pair to
// one of the option records, falling back to the default. A bare sort_by (e.g.
// the documentation template's "id" with no order) matches its A–Z variant.
function resolve({ value, sort_by, sort_order } = {}) {
  return (
    OPTIONS.find(option => option.value === value) ||
    OPTIONS.find(
      option => option.sort_by === sort_by && option.sort_order === sort_order
    ) ||
    (sort_order == null &&
      OPTIONS.find(option => option.sort_by === sort_by)) ||
    DEFAULT_OPTION
  );
}

module.exports = OPTIONS;
module.exports.DEFAULT = DEFAULT;
module.exports.resolve = resolve;
