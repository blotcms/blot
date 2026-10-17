const config = require("config");
const MAC_SERVER_ADDRESS = config.icloud.server_address;
const MACSERVER_AUTH = config.icloud.secret; // The Macserver Authorization secret from config
const fetch = require("../../util/rateLimitedFetchWithRetriesAndTimeout");

module.exports = async (blogID, path) => {
  const pathBase64 = Buffer.from(path).toString("base64");

  // readBody keeps the timeout armed while the body is read, so a stalled
  // reply fails the attempt instead of hanging the sync
  const body = await fetch(MAC_SERVER_ADDRESS + "/readdir", {
    readBody: true,
    headers: { Authorization: MACSERVER_AUTH, blogID, pathBase64 },
  });
  return JSON.parse(body.toString());
};
