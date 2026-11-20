const https = require("https");
const nodeFetch = require("node-fetch");

// The Dropbox SDK calls node-fetch (v2), which sends "Connection: close" on
// every request that has no agent, so each API call and download paid for a
// fresh TCP and TLS handshake to api.dropboxapi.com or content.dropboxapi.com.
// Giving every request this shared keep-alive agent lets sockets be reused for
// both hosts (the agent keeps its pool per host). It is passed as the SDK's
// `fetch` option, which also covers the access token refresh.
// An idle socket is closed after 15s, before Dropbox closes it from its end,
// which would reset the next request sent on it (downloads and listings retry
// a reset anyway, see retry.js and retryRequest.js).
const agent = new https.Agent({ keepAlive: true, timeout: 15 * 1000 });

module.exports = function fetch(url, options) {
  return nodeFetch(url, { agent, ...options });
};

module.exports.agent = agent;
