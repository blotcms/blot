// One line for each request or operation on the git store, the fields in a
// fixed order first:
//
//   [git-store-served] blog=<id> op=advertise|clone|fetch|push|write|...
//     outcome=... ms=... firstByteMs=... requests=... bytesDown=... bytesSent=...
//
// Blog IDs only: never handles, which are the blog owner's to change.
//
// The same lines, with the same timestamp, are also appended to
// config.git_store.log (BLOT_GIT_STORE_LOG), because the containers' stdout
// is lost at every deploy. By default that is git-store-log/git-store.log in
// tmp, which every unit mounts, so it outlives the containers (on the
// instance store in production, which a stop and start of the host wipes).
// Empty turns it off. See ./file-log.js.
const config = require("config");
const clfdate = require("helper/clfdate");
const appendToFile = require("./file-log");

const ORDER = ["blog", "op", "source", "outcome", "ms", "firstByteMs", "requests", "bytesUp", "bytesDown", "bytesSent", "waitMs", "detail"];

function value(v) {
  const text = String(v);
  return /^[\w.:/@+-]*$/.test(text) && text ? text : JSON.stringify(text.slice(0, 500));
}

function format(fields) {
  const keys = ORDER.filter((key) => fields[key] !== undefined).concat(
    Object.keys(fields).filter((key) => ORDER.indexOf(key) === -1 && fields[key] !== undefined)
  );

  return "[git-store-served] " + keys.map((key) => key + "=" + value(fields[key])).join(" ");
}

function log(fields) {
  const stamp = clfdate();
  const text = format(fields);

  console.log(stamp, text);
  appendToFile(config.git_store && config.git_store.log, stamp + " " + text);
}

module.exports = log;
module.exports.format = format;
