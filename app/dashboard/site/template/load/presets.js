const presentPresets = require("models/template/presets").presentPresets;

module.exports = function loadPresets(req, res, next) {
  const presented = presentPresets(req.template || {});
  res.locals.colorPresets = presented.colors;
  res.locals.fontPresets = presented.fonts;
  res.locals.presetFontStyles = presented.fontStyles;
  next();
};
