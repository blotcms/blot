// This is useful for maniplating colors for producing
// lower-opacity versions of the color, e.g.
// background: rgba({{#rgb}}{{text_color}}{{/rgb}}, 0.1);
const tinyColor = require("helper/tinyColor");
const asRetriever = require("../../lib/asRetriever");

module.exports = asRetriever(function (req, res) {
  return function () {
    return function (text, render) {
      let rgb = "";

      text = render(text);

      try {
        const { r, g, b } = tinyColor(text).toRgb();
        rgb = `${r}, ${g}, ${b}`;
      } catch (e) {
        return text;
      }

      return rgb;
    };
  };
});
