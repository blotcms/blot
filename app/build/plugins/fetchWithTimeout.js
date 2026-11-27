// A node-fetch for third-party oEmbed hosts. Without a bound, a host that
// accepts the connection and never answers would hold the sync (and the
// blog's folder lock) until the plugin timeout. node-fetch's timeout covers
// the response headers and the body, and rejects with a FetchError of type
// "request-timeout" or "body-timeout".

const fetch = require("node-fetch");

// Read at call time, so a spec can lower it
const settings = { timeout: 10 * 1000 };

function fetchWithTimeout(url, options = {}) {
  return fetch(url, { timeout: settings.timeout, ...options });
}

fetchWithTimeout.settings = settings;

module.exports = fetchWithTimeout;
