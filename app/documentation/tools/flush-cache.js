const config = require("config");
const host = config.host;
const flush = require("helper/flushProxies");

module.exports = () => {
  flush(host)
    .then(() => {})
    .catch((error) => {
      console.error("Error flushing cache directories:", error);
    });
};
