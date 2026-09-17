const asRetriever = require("../../lib/asRetriever");
const searchQueryString = require("../../lib/searchQuery");

module.exports = asRetriever(function (req, res) {
  return searchQueryString(req.query.q);
});
