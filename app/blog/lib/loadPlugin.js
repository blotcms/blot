const Plugins = require("build/plugins");

// Plugins.load is synchronous work behind a callback API.
function loadPlugin(file, blogPlugins) {
  return new Promise((resolve, reject) => {
    Plugins.load(file, blogPlugins, (err, html) => {
      if (err) reject(err);
      else resolve(html);
    });
  });
}

module.exports = loadPlugin;
