const config = require("config");
const MAC_SERVER_ADDRESS = config.icloud.server_address;
const Authorization = config.icloud.secret; // The Macserver Authorization secret from config
const folder = require("storage/folder");
const fetch = require("../../util/rateLimitedFetchWithRetriesAndTimeout");

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
  });
};
