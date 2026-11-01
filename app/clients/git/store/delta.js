// Applying git's delta format: two sizes (the base's and the result's) as
// little-endian varints, then instructions. An instruction starting with a set
// high bit copies a range from the base (a bitmask says which of the offset
// and length bytes follow); otherwise its low seven bits are a count of
// literal bytes to insert. A zero instruction is reserved.
const { CorruptError, TooLargeError } = require("./errors");

function readSize(delta, at) {
  let result = 0;
  let shift = 0;
  let byte;
  do {
    if (at.i >= delta.length || shift > 49) throw new CorruptError("Delta header is truncated");
    byte = delta[at.i++];
    result += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  } while (byte & 0x80);
  return result;
}

// The size of the object a delta produces, from its header alone
function resultSize(delta) {
  const at = { i: 0 };
  readSize(delta, at);
  return readSize(delta, at);
}

// Returns the base with the delta applied. Rejects a delta which doesn't fit
// its base or whose result is bigger than maxSize, before allocating it.
function applyDelta(base, delta, maxSize = Infinity) {
  const at = { i: 0 };

  if (readSize(delta, at) !== base.length) throw new CorruptError("Delta does not match its base");
  const size = readSize(delta, at);
  if (size > maxSize) throw new TooLargeError("Object is larger than " + maxSize + " bytes");

  const out = Buffer.allocUnsafe(size);
  let o = 0;

  while (at.i < delta.length) {
    const op = delta[at.i++];

    if (op & 0x80) {
      let offset = 0;
      let length = 0;
      for (let k = 0; k < 4; k++) if (op & (1 << k)) offset += delta[at.i++] * 2 ** (8 * k);
      for (let k = 0; k < 3; k++) if (op & (0x10 << k)) length += delta[at.i++] * 2 ** (8 * k);
      if (length === 0) length = 0x10000;

      if (at.i > delta.length || offset + length > base.length || o + length > size) {
        throw new CorruptError("Delta copies outside its base");
      }
      base.copy(out, o, offset, offset + length);
      o += length;
    } else if (op > 0) {
      if (at.i + op > delta.length || o + op > size) throw new CorruptError("Delta inserts past its end");
      delta.copy(out, o, at.i, at.i + op);
      at.i += op;
      o += op;
    } else {
      throw new CorruptError("Delta has a reserved instruction");
    }
  }

  if (o !== size) throw new CorruptError("Delta produced the wrong size");
  return out;
}

module.exports = { applyDelta, resultSize };
