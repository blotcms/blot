const loadPlugin = require("../../lib/loadPlugin");
const asRetriever = require("../../lib/asRetriever");

module.exports = asRetriever(async function (req, res) {
  return loadPlugin("js", req.blog.plugins);
});
