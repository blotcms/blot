const determine_input = require("./util/determine-input");

const MAP = {
  navigation_alignment: {
    label: "Alignment",
  },
  sticky_navigation: {
    label: "Fix position on page",
  },
  collapse_navigation_by_default: {
    label: "Collapse by default",
  },
  navigation_location: {
    label: "Position",
  },
  navigation_position: {
    label: "Position",
  },
};

module.exports = function (req, res, next) {
  res.locals.navigation = Object.keys(req.template.locals)

    .filter((key) => key.includes("navigation_") || key.includes("_navigation"))
    .map((key) => determine_input(key, req.template.locals, MAP))
    .filter((i) => i);

  return next();
};
