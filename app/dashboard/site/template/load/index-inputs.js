const determine_input = require("./util/determine-input");

const MAP = {
  show_adjacent_posts: {
    label: "Show adjacent"
  },
  page_size: {
    label: "Posts per page",
    min: 1,
    max: 60
  },
  index_layout: {
    label: "Layout"
  }
};

// Sorting keys are handled by the standalone "Post sorting" control
// (load/sort-input.js), so they must not also render here.
const SORT_INPUT_KEYS = {
  sort: true,
  sort_by: true,
  sort_order: true,
  sort_by_options: true,
  sort_order_options: true
};

module.exports = function (req, res, next) {
  const locals = req.template.locals || {};
  res.locals.post_adjacent_posts = determine_input(
    "show_adjacent_posts",
    locals,
    MAP
  );

  res.locals.index_page = Object.keys(locals)

    // `_image` is a declaration even when its initial value is `{}`. Never
    // allow companion range/options keys to turn it into a generic control.
    .filter(key => !key.endsWith("_image"))

    // If the template uses the thumbnails per row
    // option then hide the page size option
    .filter(key =>
      locals.thumbnails_per_row !== undefined ? key !== "page_size" : true
    )

    .filter(
      key =>
        key.indexOf("_navigation") === -1 && key.indexOf("navigation_") === -1
    )

    .filter(key => !SORT_INPUT_KEYS[key])
    .filter(key => key !== "show_adjacent_posts")

    .filter(
      key =>
        [
          "page_size",
          "spacing_size",
          "spacing",
          "thumbnails_per_row",
          "number_of_rows"
        ].indexOf(key) > -1 ||
        (typeof locals[key] === "boolean" &&
          ["hide_dates"].indexOf(key) === -1) ||
        (key.indexOf("_range") === -1 &&
          locals[key + "_range"] &&
          locals[key + "_range"].constructor === Array) ||
        (key.indexOf("_options") === -1 &&
          locals[key + "_options"] &&
          locals[key + "_options"].constructor === Array)
    )
    .map(key => determine_input(key, locals, MAP))
    .filter(i => i);

  return next();
};
