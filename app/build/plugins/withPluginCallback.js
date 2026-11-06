const withCallback = require("helper/withCallback");

// A plugin's render($, callback, options) and prerender(contents, callback,
// options) take their callback second, where helper/withCallback expects it
// last. This writes the plugin as an async function of (input, options) and
// bridges it to the plugin contract the runner (./index.js), the specs and
// scripts/build-probe call: the callback is called once, with (err) or
// (null, result).
module.exports = function withPluginCallback(fn) {
  const bridged = withCallback(fn);

  return function (input, callback, options) {
    return bridged(input, options, callback);
  };
};
