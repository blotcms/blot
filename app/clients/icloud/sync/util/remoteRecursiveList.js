const config = require("config");
const fetch = require("../../util/rateLimitedFetchWithRetriesAndTimeout");

const MAC_SERVER_ADDRESS = config.icloud.server_address;
const MACSERVER_AUTH = config.icloud.secret;
const RECURSIVE_LIST_TIMEOUT_MS = 90 * 1000;

module.exports = async (blogID, path = "/", { signal } = {}) => {
  if (!blogID) throw new Error("blogID is required");

  const pathBase64 = Buffer.from(path).toString("base64");

  await fetch(MAC_SERVER_ADDRESS + "/recursiveList", {
    method: "POST",
    timeout: RECURSIVE_LIST_TIMEOUT_MS,
    signal,
    headers: {
      Authorization: MACSERVER_AUTH,
      blogID,
      pathBase64,
    },
  });

  return true;
};
