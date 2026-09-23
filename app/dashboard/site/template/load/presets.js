const presentPresets = require("../presets").presentPresets;

module.exports = function loadPresets(req, res, next) {
  const presented = presentPresets(req.template || {});
  res.locals.colorPresets = presented.colors;
  res.locals.fontPresets = presented.fonts;
  next();
};
