const key = require("./key");
const client = require("models/client");
const ensure = require("helper/ensure");
const { TYPE } = require("./scheme");

// We'll store only two thousand status log items
const STATUS_LOG_MAX_LENGTH = 2000;

module.exports = async function setStatus(blogID, status) {
  ensure(blogID, "string").and(status, "object");

  // Default values
  status.datestamp =
    status.datestamp === undefined ? Date.now() : status.datestamp;
  status.syncID = status.syncID === undefined ? "" : status.syncID;

  ensure(status, TYPE.status, true);

  const multi = client.multi();
  const statusString = JSON.stringify(status);

  multi.hSet(key.info(blogID), "status", statusString);
  multi.lPush(key.status(blogID), statusString);
  multi.lTrim(key.status(blogID), 0, STATUS_LOG_MAX_LENGTH);

  await multi.exec();
};
