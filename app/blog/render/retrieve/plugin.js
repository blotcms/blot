const Plugins = require("build/plugins");
const asRetriever = require("../../lib/asRetriever");

module.exports = asRetriever(function (req, res) {
  let requested = (req.retrieve && req.retrieve.plugin) || {};
  const response = {};
  const pluginList = Plugins.list || {};
  const blogPlugins = (req.blog && req.blog.plugins) || {};

  if (requested === true || typeof requested !== "object") requested = {};

  Object.keys(requested).forEach(function (pluginName) {
    const pluginRequest = requested[pluginName];
    const pluginConfig = blogPlugins[pluginName];
    const pluginMeta = pluginList[pluginName];

    if (!pluginMeta || !pluginConfig || !pluginConfig.enabled) return;
    if (!pluginRequest || typeof pluginRequest !== "object") return;

    const value = {};

    if (pluginRequest.css) value.css = pluginMeta.publicCSS || "";
    if (pluginRequest.js) value.js = pluginMeta.publicJS || "";

    if (Object.keys(value).length) response[pluginName] = value;
  });

  if (!Object.keys(response).length) return;

  return response;
});
