const asRetriever = require("../../lib/asRetriever");

module.exports = asRetriever(function (req, res) {
  return req.query.q;
});
