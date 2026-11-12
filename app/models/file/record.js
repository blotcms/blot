// A record is { type: "file" | "dir", size, modified, sha1, flags }, with
// size in bytes, modified in milliseconds since the epoch, sha1 in hex (""
// when not known, and always for a directory) and flags an array of
// { code, ...detail } (see flags.js). Most files have no flags, and then
// parse leaves the key out. In Redis it is
// packed into one short string, "f|size|modified|sha1" or "d|0|modified|",
// with "|" and the flags as JSON after it when there are any. That is the
// value of the child's field in its parent directory's hash. The packing
// stays behind this module, so it can change without callers noticing.

var TYPES = { file: "f", dir: "d" };

function pack(record) {
  var type = TYPES[record.type];

  if (!type) throw new Error("models/file: record type must be file or dir");

  var isFile = type === "f";
  var size = isFile ? Number(record.size) || 0 : 0;
  var modified = Math.round(Number(record.modified) || 0);
  var sha1 = isFile ? record.sha1 || "" : "";
  var flags = Array.isArray(record.flags) ? record.flags : [];

  if (sha1 && !/^[0-9a-f]{40}$/.test(sha1)) {
    throw new Error("models/file: sha1 must be 40 hex characters");
  }

  var packed = [type, size, modified, sha1].join("|");

  return flags.length ? packed + "|" + JSON.stringify(flags) : packed;
}

// The flags are everything after the fourth "|", since their JSON may hold
// a "|" of its own. A record written before flags existed has none, and so
// has one whose flags fail to parse: losing them is better than failing
// every listing of the directory.
function parseFlags(parts) {
  if (parts.length < 5) return [];

  try {
    var flags = JSON.parse(parts.slice(4).join("|"));
    return Array.isArray(flags) ? flags : [];
  } catch (err) {
    return [];
  }
}

function parse(packed) {
  if (packed === null || packed === undefined) return null;

  var parts = String(packed).split("|");
  var flags = parseFlags(parts);
  var record = {
    type: parts[0] === "d" ? "dir" : "file",
    size: parseInt(parts[1], 10) || 0,
    modified: parseInt(parts[2], 10) || 0,
    sha1: parts[3] || "",
  };

  // Only a record with flags has the key, so most records stay four fields
  if (flags.length) record.flags = flags;

  return record;
}

module.exports = { pack, parse };
