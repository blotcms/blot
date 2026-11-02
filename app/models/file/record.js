// A record is { type: "file" | "dir", size, modified, sha1 }, with size in
// bytes, modified in milliseconds since the epoch and sha1 in hex ("" when
// not known, and always for a directory). In Redis it is packed into one
// short string, "f|size|modified|sha1" or "d|0|modified|", the value of the
// child's field in its parent directory's hash. The packing stays behind
// this module, so it can change without callers noticing.

var TYPES = { file: "f", dir: "d" };

function pack(record) {
  var type = TYPES[record.type];

  if (!type) throw new Error("models/file: record type must be file or dir");

  var isFile = type === "f";
  var size = isFile ? Number(record.size) || 0 : 0;
  var modified = Math.round(Number(record.modified) || 0);
  var sha1 = isFile ? record.sha1 || "" : "";

  if (sha1 && !/^[0-9a-f]{40}$/.test(sha1)) {
    throw new Error("models/file: sha1 must be 40 hex characters");
  }

  return [type, size, modified, sha1].join("|");
}

function parse(packed) {
  if (packed === null || packed === undefined) return null;

  var parts = String(packed).split("|");

  return {
    type: parts[0] === "d" ? "dir" : "file",
    size: parseInt(parts[1], 10) || 0,
    modified: parseInt(parts[2], 10) || 0,
    sha1: parts[3] || "",
  };
}

module.exports = { pack, parse };
