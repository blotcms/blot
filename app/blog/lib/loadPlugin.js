const Plugins = require("build/plugins");

// Plugins.load is synchronous work behind an async API.
function loadPlugin(file, blogPlugins) {
  return Plugins.load(file, blogPlugins);
}

module.exports = loadPlugin;
