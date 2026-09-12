const loadPlugin = require("../../lib/loadPlugin");
const asRetriever = require("../../lib/asRetriever");

module.exports = asRetriever(async function (req, res) {
  return loadPlugin("css", req.blog.plugins);
});
