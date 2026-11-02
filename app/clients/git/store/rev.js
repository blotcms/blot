// Builds a pack's .rev file (git's version 1 reverse index) from its .idx.
//
// The .idx lists objects by ID and says where each starts in the pack. A .rev
// is the other direction: for each entry in pack order, its position in the
// .idx. With it, the entry after a given one is known, and so where the given
// entry ends, which the .idx alone does not say. Streaming a clone needs that
// to copy entries without inflating them.
//
// The format is "RIDX", the version (1), the hash function (1 for SHA-1), one
// 4-byte .idx position per entry in pack order, the pack's checksum, and a
// checksum of all that. It is what `git index-pack --rev-index` writes, and
// the spec compares them.
const crypto = require("crypto");
const { CorruptError } = require("./errors");

const FANOUT_END = 8 + 256 * 4;

function buildRev(idx) {
  if (idx.length < FANOUT_END + 40 || idx.readUInt32BE(0) !== 0xff744f63 || idx.readUInt32BE(4) !== 2) {
    throw new CorruptError("Not a version 2 pack index");
  }

  const count = idx.readUInt32BE(FANOUT_END - 4);
  const offsetsAt = FANOUT_END + count * 24;
  const largeAt = offsetsAt + count * 4;
  if (idx.length < largeAt + 40) throw new CorruptError("The pack index is shorter than its fanout says");

  const offsetOf = (position) => {
    const value = idx.readUInt32BE(offsetsAt + position * 4);
    if (!(value & 0x80000000)) return value;
    return Number(idx.readBigUInt64BE(largeAt + (value & 0x7fffffff) * 8));
  };

  const offsets = new Array(count);
  for (let i = 0; i < count; i++) offsets[i] = offsetOf(i);
  const order = offsets.map((_, position) => position).sort((a, b) => offsets[a] - offsets[b]);

  const body = Buffer.alloc(12 + count * 4);
  body.write("RIDX");
  body.writeUInt32BE(1, 4);
  body.writeUInt32BE(1, 8);
  order.forEach((position, i) => body.writeUInt32BE(position, 12 + i * 4));

  const withPackChecksum = Buffer.concat([body, idx.subarray(idx.length - 40, idx.length - 20)]);
  return Buffer.concat([withPackChecksum, crypto.createHash("sha1").update(withPackChecksum).digest()]);
}

module.exports = { buildRev };
