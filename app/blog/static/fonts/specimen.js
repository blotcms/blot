const config = require("config");

// The URL and size of a font's specimen, the image of its name drawn in the
// font (text.svg in its directory, served by the CDN like the font files).
// Spread the result into the view of an option. Fonts without one, the system
// fonts, give {} and the view falls back to the name in the font's stack.
module.exports = function specimen(font) {
  if (!font || !font.specimen) return {};

  return {
    specimenURL: `${config.cdn.origin}/fonts/${font.id}/text.svg?version=${font.specimen.hash}`,
    specimenWidth: font.specimen.width,
    specimenHeight: font.specimen.height,
  };
};
