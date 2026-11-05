// One line for each request or operation on the git store, the fields in a
// fixed order first, to stdout like the rest of the app's logging:
//
//   [git-store-served] blog=<id> op=advertise|clone|fetch|push|write|...
//     outcome=... ms=... firstByteMs=... requests=... bytesDown=... bytesSent=...
//
// Blog IDs only: never handles, which are the blog owner's to change.
const clfdate = require("helper/clfdate");

const ORDER = ["blog", "op", "source", "outcome", "ms", "firstByteMs", "requests", "bytesUp", "bytesDown", "bytesSent", "waitMs", "reason", "detail"];

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
  console.log(clfdate(), format(fields));
}

module.exports = log;
module.exports.format = format;
