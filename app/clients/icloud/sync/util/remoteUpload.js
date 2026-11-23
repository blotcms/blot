const config = require("config");
const MAC_SERVER_ADDRESS = config.icloud.server_address;
const Authorization = config.icloud.secret; // The Macserver Authorization secret from config
const folder = require("storage/folder");
const fetch = require("../../util/rateLimitedFetchWithRetriesAndTimeout");

// Waits 1s then 2s between attempts, so a macserver restart doesn't fail a
// dashboard edit, which would then be undone by the next walk
const RETRY_DELAY_MS = 1000;

module.exports = async (blogID, path) => {
  const stat = await folder.stat(blogID, path);
  // Milliseconds, with the fraction fs.stat gives: the same value as before
  const modifiedTime = stat.modified;
  const pathBase64 = Buffer.from(path).toString("base64");

  const body = await folder.read(blogID, path);

  // rateLimitedFetchWithRetriesAndTimeout throws on non-OK responses
  await fetch(`${MAC_SERVER_ADDRESS}/upload`, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      Authorization, // Use the Authorization header
      blogID,
      pathBase64,
      modifiedTime,
    },
    body,
    retryDelay: RETRY_DELAY_MS,
  });
};
