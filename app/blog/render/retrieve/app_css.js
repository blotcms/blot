const loadPlugin = require("../../lib/loadPlugin");
const asRetriever = require("../../lib/asRetriever");
const renderPluginAssets = require("./helpers/renderPluginAssets");

module.exports = asRetriever(async function (req, res) {
  const source = await loadPlugin("css", req.blog.plugins);
  return renderPluginAssets(source, req, res);
});
