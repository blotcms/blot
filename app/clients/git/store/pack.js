// Reads single entries out of a pack file by range.
//
// A pack is a 12-byte header ("PACK", version, object count), the entries
// back to back, and a 20-byte checksum. An entry is a header (its type and
// inflated size, then for a delta where its base is) followed by one zlib
// stream. The index gives where an entry starts, not where it ends; the end
// is wherever its zlib stream ends (see inflate.js).
const { CorruptError, NotFoundError, TooLargeError } = require("./errors");
const inflateStream = require("./inflate");

const HEADER = 12;
const TRAILER = 20;

const TYPES = { 1: "commit", 2: "tree", 3: "blob", 4: "tag" };
const OFS_DELTA = 6;
const REF_DELTA = 7;

// The first read of an entry takes its header and, for most commits and trees,
// all its data. After that reads grow, so a large entry is a handful of reads.
const FIRST_READ = 4096;
const NEXT_READ = 64 * 1024;
const MAX_READ = 1024 * 1024;

// The longest an entry header can be: a 10-byte size and a 20-byte base ID
const MAX_HEADER = 32;

// Parses the entry header at the start of `buffer`, an entry at `offset`
function parseHeader(buffer, offset) {
  let i = 0;
  const truncated = () => new CorruptError("Pack entry at " + offset + " has a truncated header");
  const next = () => {
    if (i >= buffer.length) throw truncated();
    return buffer[i++];
  };

  let byte = next();
  const code = (byte >> 4) & 7;
  let size = byte & 15;
  let shift = 4;
  while (byte & 0x80) {
    if (shift > 53) throw new CorruptError("Pack entry at " + offset + " has an impossible size");
    byte = next();
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }

  const header = { size, length: 0 };

  if (code === OFS_DELTA) {
    byte = next();
    let distance = byte & 0x7f;
    while (byte & 0x80) {
      byte = next();
      distance = (distance + 1) * 128 + (byte & 0x7f);
    }
    if (distance <= 0 || offset - distance < HEADER) {
      throw new CorruptError("Pack entry at " + offset + " has a base outside the pack");
    }
    header.baseOffset = offset - distance;
  } else if (code === REF_DELTA) {
    if (i + 20 > buffer.length) throw truncated();
    header.baseOid = buffer.subarray(i, i + 20).toString("hex");
    i += 20;
  } else if (TYPES[code]) {
    header.type = TYPES[code];
  } else {
    throw new CorruptError("Pack entry at " + offset + " has an invalid type");
  }

  header.length = i;
  return header;
}

function isDelta(entry) {
  return entry.baseOffset !== undefined || entry.baseOid !== undefined;
}

// Opens a pack for reading entries. `size` is the pack's length (from the
// manifest), which is how a truncated pack is told from a whole one.
function openPack({ store, key, size, name }) {
  const end = size - TRAILER;

  // The pack in the store must be the length the manifest says. Checked once
  // per pack opened, alongside the first read.
  let sized = null;
  function checkSize() {
    if (!sized) {
      sized = store
        .head(key)
        .then((found) => {
          if (!found) throw new NotFoundError(name + " is not in the store");
          if (found.size !== size) throw new CorruptError(name + " is " + found.size + " bytes; the manifest says " + size);
        })
        .catch((err) => {
          sized = null;
          throw err;
        });
    }
    return sized;
  }

  // Reads may run into the trailer, which is not an entry's but is always
  // there to tell the end of the last entry's stream from the end of the data
  async function readRange(offset, length) {
    return store.read(key, offset, Math.min(length, size - offset));
  }

  // The compressed bytes from `start`, `first` already read, in growing reads.
  // The consumer says (through next) when it wants only a few more bytes.
  async function* compressed(start, first) {
    let at = start + first.length;
    let length = NEXT_READ;
    let wanted = yield first;
    while (at < size) {
      const bytes = await readRange(at, wanted || length);
      if (!bytes.length) return;
      at += bytes.length;
      if (!wanted) length = Math.min(length * 2, MAX_READ);
      wanted = yield bytes;
    }
  }

  // Starts reading the entry at `offset`: its header, and `output`, an async
  // iterable of its inflated data. After output is finished, `end()` is where
  // the entry ends in the pack. A delta's data is the delta, not the object.
  async function open(offset, maxSize = Infinity) {
    if (!Number.isSafeInteger(offset) || offset < HEADER || offset >= end) {
      throw new CorruptError(name + " has no entry at offset " + offset);
    }

    const [first] = await Promise.all([readRange(offset, FIRST_READ), checkSize()]);
    const entry = parseHeader(first.subarray(0, MAX_HEADER), offset);
    if (entry.size > maxSize) throw new TooLargeError("Pack entry at " + offset + " is larger than " + maxSize + " bytes");

    const dataStart = offset + entry.length;
    const stream = inflateStream(compressed(dataStart, first.subarray(entry.length)), entry.size, name + " entry at " + offset);

    entry.offset = offset;
    entry.output = stream.output;
    entry.end = () => {
      const entryEnd = dataStart + stream.consumed();
      if (entryEnd > end) throw new CorruptError("Pack entry at " + offset + " runs into the pack's checksum");
      return entryEnd;
    };
    return entry;
  }

  // Reads the entry at `offset` into memory. `end` is where it ends.
  async function read(offset, maxSize) {
    const entry = await open(offset, maxSize);
    const chunks = [];
    for await (const chunk of entry.output) chunks.push(chunk);

    entry.data = Buffer.concat(chunks);
    entry.end = entry.end();
    delete entry.output;
    return entry;
  }

  return { name, size, open, read };
}

module.exports = { openPack, isDelta, parseHeader };
