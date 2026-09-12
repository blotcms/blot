// This is useful for forming urls from entry properties
// e.g href="https://example.com?text={{#encode_uri_component}}{{title}}{{/encode_uri_component}}""
// and should be used by the social sharing buttons plugin when it exists
const asRetriever = require("../../lib/asRetriever");

module.exports = asRetriever(function (req, res) {
  return function () {
    return function (text, render) {
      let encoded_text = "";

      text = render(text);

      try {
        encoded_text = encodeURIComponent(text);
      } catch (e) {
        return text;
      }

      return encoded_text;
    };
  };
});
