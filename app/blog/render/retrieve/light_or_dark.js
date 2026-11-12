// Returns "light" or "dark" for a passed colour, so a template can adjust its
// contrast, or set CSS color-scheme, for whichever background the blog uses:
//
//   <html data-scheme="{{#light_or_dark}}{{background_color}}{{/light_or_dark}}">
//
// A colour is dark when its perceived brightness is below half (tinycolor's
// isDark: (299R + 587G + 114B) / 1000 < 128). Transparency is ignored. A value
// that isn't a colour returns nothing.
const tinyColor = require("tinycolor2");
const asRetriever = require("../../lib/asRetriever");

module.exports = asRetriever(function () {
  return function () {
    return function (text, render) {
      const color = tinyColor(render(text).trim());
      if (!color.isValid()) return "";
      return color.isDark() ? "dark" : "light";
    };
  };
});
