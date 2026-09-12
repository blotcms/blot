const normalize = require("helper/urlNormalizer");
const asRetriever = require("../../lib/asRetriever");

module.exports = asRetriever(function (req, res) {
  return function () {
    const url = normalize(req.url) || "/";

    return function (text) {
      let active = "";

      if (text === url) active = "active";

      return active;
    };
  };
});
