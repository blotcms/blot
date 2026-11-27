const config = require("config");
const MAC_SERVER_ADDRESS = config.icloud.server_address;
const MACSERVER_AUTH = config.icloud.secret; // The Macserver Authorization secret from config
const fetch = require("../../util/rateLimitedFetchWithRetriesAndTimeout");

// Waits 1s then 2s between attempts, so a macserver restart doesn't fail a
// dashboard edit, which would then be undone by the next walk
const RETRY_DELAY_MS = 1000;

module.exports = async (blogID, path, { signal } = {}) => {
  const pathBase64 = Buffer.from(path).toString("base64");

  // rateLimitedFetchWithRetriesAndTimeout throws on non-OK responses
  await fetch(MAC_SERVER_ADDRESS + "/delete", {
    method: "POST",
    headers: { Authorization: MACSERVER_AUTH, blogID, pathBase64 },
    retryDelay: RETRY_DELAY_MS,
    signal,
  });
};
