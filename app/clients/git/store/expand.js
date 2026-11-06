// Applies a delta to a file, writing the result to another file, with memory
// that does not depend on the size of either. This is how the reader streams
// an object stored as a delta which is too big to resolve in memory (see
// reader.js): the base is written to scratch, then each delta of the chain is
// applied to the file before it, so a chain is a series of files and never
// more than two exist at once.
//
// The delta arrives as an async iterable of Buffers (the inflated entry) and
// is parsed as it comes, so it is never held whole either. A copy is a
// positional read from the source file straight into the output buffer; an
// insert passes the delta's bytes through. The format is the one delta.js
// applies in memory (the header's two sizes, then copy and insert
// instructions), and the checks are the same: the source must be the size the
// header says, a copy must lie inside the source, nothing may be written past
// the target size, and exactly the target size must be written. Anything else
// is a CorruptError.
const fsp = require("fs/promises");
const { CorruptError } = require("./errors");

// The output is written in blocks of this size. It is also the most memory a
// copy of any length uses, since a long copy is read and written a block at a
// time.
const BLOCK = 256 * 1024;

// The longest instruction: a copy with all seven of its offset and length
// bytes, or an insert of 127 bytes, each with its opcode
const MAX_OP = 128;

// Two varints of up to 8 bytes each fit in this, with room to spare
const HEADER = 32;

// A cursor over an async iterable of Buffers which keeps a window of bytes to
// parse from. `fill(n)` makes at least n bytes available unless the input has
// ended, and the parse itself is synchronous, so a delta of a million
// instructions is not a million awaits.
function createCursor(input) {
  const iterator = input[Symbol.asyncIterator]();
  let buffer = Buffer.alloc(0);
  let at = 0;
  let ended = false;

  return {
    available: () => buffer.length - at,
    async fill(n) {
      while (buffer.length - at < n && !ended) {
        const next = await iterator.next();
        if (next.done) ended = true;
        else
          buffer =
            buffer.length - at
              ? Buffer.concat([buffer.subarray(at), next.value])
              : next.value;
        if (!next.done) at = 0;
      }
    },
    byte: () => buffer[at++],
    take(n) {
      const bytes = buffer.subarray(at, at + n);
      at += n;
      return bytes;
    },
    close: () =>
      iterator.return ? iterator.return().catch(() => {}) : Promise.resolve(),
  };
}

// Reads a size varint (as delta.js does) from the cursor
function readSize(cursor) {
  let result = 0;
  let shift = 0;
  let byte;
  do {
    if (!cursor.available() || shift > 49)
      throw new CorruptError("Delta header is truncated");
    byte = cursor.byte();
    result += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  } while (byte & 0x80);
  return result;
}

async function writeAll(handle, buffer, length) {
  for (let done = 0; done < length;) {
    const { bytesWritten } = await handle.write(buffer, done, length - done);
    done += bytesWritten;
  }
}

// Writes the bytes of an async iterable to `file`; resolves with how many
async function writeFile(file, input) {
  const handle = await fsp.open(file, "w");
  let bytes = 0;
  try {
    for await (const chunk of input) {
      await writeAll(handle, chunk, chunk.length);
      bytes += chunk.length;
    }
  } finally {
    await handle.close();
  }
  return bytes;
}

// Applies `delta` to the file `source` (which is `sourceSize` bytes) and writes
// the result to `target`. `room(size)` is called with the result's size, from
// its header and before anything is written, so the caller can find the disk
// space for it or refuse. Resolves with the result's size.
async function applyDeltaToFile({ source, sourceSize, delta, target, room }) {
  const cursor = createCursor(delta);
  const input = await fsp.open(source, "r");
  let output = null;

  try {
    await cursor.fill(HEADER);
    if (readSize(cursor) !== sourceSize)
      throw new CorruptError("Delta does not match its base");
    const size = readSize(cursor);

    await room(size);
    output = await fsp.open(target, "w");

    const block = Buffer.allocUnsafe(Math.min(BLOCK, Math.max(size, 1)));
    let filled = 0;
    let written = 0;

    async function flush() {
      await writeAll(output, block, filled);
      filled = 0;
    }

    for (;;) {
      await cursor.fill(MAX_OP);
      if (!cursor.available()) break;

      const op = cursor.byte();

      if (op & 0x80) {
        let offset = 0;
        let length = 0;
        let needed = 0;
        for (let k = 0; k < 7; k++) if (op & (1 << k)) needed++;
        if (cursor.available() < needed)
          throw new CorruptError("Delta copies outside its base");

        for (let k = 0; k < 4; k++)
          if (op & (1 << k)) offset += cursor.byte() * 2 ** (8 * k);
        for (let k = 0; k < 3; k++)
          if (op & (0x10 << k)) length += cursor.byte() * 2 ** (8 * k);
        if (length === 0) length = 0x10000;

        if (offset + length > sourceSize || written + length > size)
          throw new CorruptError("Delta copies outside its base");

        for (let from = offset, left = length; left > 0;) {
          if (filled === block.length) await flush();
          const want = Math.min(left, block.length - filled);
          const { bytesRead } = await input.read(block, filled, want, from);
          if (!bytesRead)
            throw new CorruptError(
              "The file a delta is applied to is shorter than it was written"
            );
          filled += bytesRead;
          from += bytesRead;
          left -= bytesRead;
        }
        written += length;
      } else if (op > 0) {
        if (cursor.available() < op || written + op > size)
          throw new CorruptError("Delta inserts past its end");
        if (filled + op > block.length) await flush();
        cursor.take(op).copy(block, filled);
        filled += op;
        written += op;
      } else {
        throw new CorruptError("Delta has a reserved instruction");
      }
    }

    if (written !== size)
      throw new CorruptError("Delta produced the wrong size");
    await flush();
    return size;
  } finally {
    await cursor.close();
    await input.close();
    if (output) await output.close();
  }
}

module.exports = { applyDeltaToFile, writeFile };
