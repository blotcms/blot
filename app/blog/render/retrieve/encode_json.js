// This is useful for creating a JSON feed. Mustache's
// default escaping does not encode newlines, which causes
// problems.
const asRetriever = require("../../lib/asRetriever");

module.exports = asRetriever(function (req, res) {
  return function () {
    return function (text, render) {
      let encoded_text = "";

      text = render(text);

      try {
        // We remove the first and last character of the string
        // to remove the double quotes (").
        encoded_text = JSON.stringify(text).slice(1, -1);
      } catch (e) {
        return text;
      }

      return encoded_text;
    };
  };
});
