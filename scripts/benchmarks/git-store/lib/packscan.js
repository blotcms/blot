// Reads an incoming pack that is in memory, far enough to know which deltas
// refer to objects the pack does not contain.
const zlib = require("zlib");
const crypto = require("crypto");

const NAMES = { 1: "commit", 2: "tree", 3: "blob", 4: "tag" };

// Returns { count, whole: Set of IDs of the objects stored whole, bases: Set
// of IDs the REF_DELTA entries name }. The bases which are not in `whole` are
// what a thin pack needs from the repository (or objects of the pack which are
// themselves deltas, which index-pack resolves).
function scanPack(buffer) {
  if (buffer.length < 32 || buffer.toString("latin1", 0, 4) !== "PACK" || buffer.readUInt32BE(4) !== 2) {
    throw new Error("Not a version 2 pack");
  }
  const count = buffer.readUInt32BE(8);
  const whole = new Set();
  const bases = new Set();
  let at = 12;

  for (let i = 0; i < count; i++) {
    let byte = buffer[at++];
    const code = (byte >> 4) & 7;
    let size = byte & 15;
    let shift = 4;
    while (byte & 0x80) {
      byte = buffer[at++];
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    if (code === 6) {
      while (buffer[at++] & 0x80);
    } else if (code === 7) {
      bases.add(buffer.toString("hex", at, at + 20));
      at += 20;
    } else if (!NAMES[code]) {
      throw new Error("Bad object type in pack");
    }

    const out = zlib.inflateSync(buffer.subarray(at), { info: true });
    if (out.buffer.length !== size) throw new Error("Pack entry has the wrong size");
    at += out.engine.bytesWritten;
    if (NAMES[code]) {
      const oid = crypto
        .createHash("sha1")
        .update(NAMES[code] + " " + size + "\0")
        .update(out.buffer)
        .digest("hex");
      whole.add(oid);
    }
  }

  if (at + 20 !== buffer.length) throw new Error("The pack has data after its last entry");
  return { count, whole, bases };
}

module.exports = { scanPack };
