const font = require("./util/font");

module.exports = function (req, res, next) {
  const fonts = Object.keys(req.template.locals)
    .filter(key => key.indexOf("_font") > -1 || key === "font")
    .filter(key => key !== "syntax_highlighter_font")
    .map(key => font(key, req.template.locals[key]));

  res.locals.fonts = fonts;
  res.locals.singleFontInput = fonts.length === 1;
  res.locals.fontPickerOptions = font("", {}).options;

  return next();
};
