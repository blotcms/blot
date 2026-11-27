const font = require("./util/font");

// The picker lists every font, and the list never changes while the process
// runs, so build it once
let pickerOptions;

module.exports = function (req, res, next) {
  const fonts = Object.keys(req.template.locals)
    .filter((key) => key.indexOf("_font") > -1 || key === "font")
    .filter((key) => key !== "syntax_highlighter_font")
    .map((key) => font(key, req.template.locals[key]));

  res.locals.fonts = fonts;
  res.locals.singleFontInput = fonts.length === 1;

  // Only templates with a font setting (or a code font) show the picker
  if (fonts.length || req.template.locals.syntax_highlighter_font) {
    pickerOptions = pickerOptions || font("", {}).options;
    res.locals.fontPickerOptions = pickerOptions;
  }

  return next();
};
