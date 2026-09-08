const SORT_OPTIONS = require("../sort-options");

// Mirror the chosen option onto every shape template code might read:
// flat sort_by / sort_order, and a nested sort object (direction and its
// `order` alias) when the template already uses one.
const applySortSelection = (locals, option) => {
  locals.sort_by = option.sort_by;
  locals.sort_order = option.sort_order;

  if (locals.sort && typeof locals.sort === "object") {
    locals.sort.by = option.sort_by;
    locals.sort.direction = option.sort_order;
    if (Object.prototype.hasOwnProperty.call(locals.sort, "order")) {
      locals.sort.order = option.sort_order;
    }
  }
};

module.exports = function (req, res, next) {
  // the user has not clicked on a button in the 'color scheme' list
  if (req.locals.thumbnails_per_row && req.locals.number_of_rows) {
    req.locals.page_size =
      parseInt(req.locals.thumbnails_per_row) *
      parseInt(req.locals.number_of_rows);
  }

  // The Post sorting select posts its own form as `locals.sort_by` carrying a
  // composite value like "date_asc". Every other sidebar form must leave the
  // existing sort settings untouched.
  const submitted =
    req.body &&
    (req.body["locals.sort_by"] ??
      (req.body.locals && req.body.locals.sort_by));

  if (submitted !== undefined) {
    // Accept both the new composite values and the legacy raw "id" / "date"
    // still posted by an old open dashboard tab (which keeps the stored order).
    const option =
      SORT_OPTIONS.find(o => o.value === submitted) ||
      SORT_OPTIONS.resolve({
        sort_by: submitted,
        sort_order: req.locals.sort_order
      });
    applySortSelection(req.locals, option);
  } else if (SORT_OPTIONS.some(o => o.value === req.locals.sort_by)) {
    // A leftover composite value ended up stored in locals; normalise it.
    applySortSelection(req.locals, SORT_OPTIONS.resolve({ value: req.locals.sort_by }));
  }

  next();
};
