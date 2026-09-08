const getTemplateSortOptions = require("blog/sortOptions");
const SORT_OPTIONS = require("../sort-options");

// The "Post sorting" select governs every post listing — index page, tag pages,
// search results and feeds — so it is built here as its own control rather than
// alongside the index-page layout inputs.

// Respect a template's sort_by_options / sort_order_options allowlists, the
// same way the now-removed raw sort_by / sort_order selects did.
const narrow = (options, allowed, pick) => {
  if (!Array.isArray(allowed) || !allowed.length) return options;
  const filtered = options.filter(option => allowed.includes(pick(option)));
  return filtered.length ? filtered : options;
};

const availableOptions = locals => {
  let options = narrow(SORT_OPTIONS, locals?.sort_by_options, o => o.sort_by);
  options = narrow(options, locals?.sort_order_options, o => o.sort_order);
  return options;
};

const buildSortControl = locals => {
  const options = availableOptions(locals);
  const { sortBy, order } = getTemplateSortOptions(locals);
  const selected = SORT_OPTIONS.resolve({ sort_by: sortBy, sort_order: order });
  const selectedValue = options.includes(selected)
    ? selected.value
    : options[0].value;

  return {
    key: "sort_by",
    label: "Order",
    value: selectedValue,
    isSelect: true,
    options: options.map(option => ({
      label: option.label,
      value: option.value,
      selected: option.value === selectedValue ? "selected" : ""
    }))
  };
};

module.exports = function (req, res, next) {
  res.locals.post_sorting = buildSortControl(req.template.locals || {});
  return next();
};
