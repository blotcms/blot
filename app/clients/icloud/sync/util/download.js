const config = require("config");
const MAC_SERVER_ADDRESS = config.icloud.server_address;
const MACSERVER_AUTH = config.icloud.secret; // The Macserver Authorization secret from config
const localPath = require("helper/localPath");
const fs = require("fs-extra");
const fetch = require("../../util/rateLimitedFetchWithRetriesAndTimeout");

const DOWNLOAD_TIMEOUT_MS = 60 * 1000;


module.exports = async (blogID, path) => {
  const pathBase64 = Buffer.from(path).toString("base64");
  // The macserver may first run `brctl download` for an evicted file (up to
  // 15s), so allow longer than the default 10s. With readBody the timeout
  // also applies between body chunks, so a stalled body is aborted and
  // retried instead of hanging the sync (and its folder lock) forever.
  const buffer = await fetch(MAC_SERVER_ADDRESS + "/download", {
    timeout: DOWNLOAD_TIMEOUT_MS,
    readBody: true,
    headers: { Authorization: MACSERVER_AUTH, blogID, pathBase64 },
  });
  const pathOnDisk = localPath(blogID, path);
  await fs.outputFile(pathOnDisk, buffer);
  return pathOnDisk;
};
