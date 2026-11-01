// Inflates one zlib stream out of a larger sequence of bytes, and says where
// the stream ended.
//
// A pack entry's compressed bytes are followed directly by the next entry,
// and the index doesn't say where one ends. Inflating until zlib stops taking
// input is how this store finds the end of an entry (see the README for why
// that rather than a .rev file). It also checks the entry: zlib verifies the
// stream's checksum, and the output must be exactly the size the entry's
// header promised.
//
// Input is fed in small pieces and only when the stream needs more, so a read
// of an entry fetches no more bytes than it takes, and the memory in use is
// bounded whatever the entry's size: at most one piece's worth of output (a
// piece which compresses a thousandfold is the worst case) is held at a time.
const zlib = require("zlib");
const { CorruptError } = require("./errors");

// How much input is given to zlib at once
const PIECE = 16 * 1024;

// Once all of an entry's data is out, zlib still needs its few bytes of
// checksum. This is how many to ask the input for then; it is enough to tell
// that the stream ended and not so many that they are wasted.
const TAIL = 16;

// Resolves once zlib has taken the piece, or the stream has failed and closed
// (in which case the write's callback may never come)
function write(stream, piece) {
  return new Promise((resolve) => {
    const done = () => {
      stream.off("close", done);
      resolve();
    };
    stream.once("close", done);
    stream.write(piece, done);
  });
}

// Returns { output, consumed }. `output` is an async iterable of the inflated
// chunks, never more than `size` bytes in all. `input` is an async iterable of
// Buffers which may run well past the end of the stream; it is only pulled
// when more is needed, and is told how many bytes it should fetch (`next(n)`)
// once only the stream's tail is wanted. Once `output` has finished,
// consumed() is how many input bytes the stream took.
function inflateStream(input, size, what) {
  let inflate = null;

  async function* output() {
    inflate = zlib.createInflate();
    const iterator = input[Symbol.asyncIterator]();
    const queue = [];
    let total = 0;
    let fed = 0;
    let failure = null;

    inflate.on("data", (chunk) => {
      total += chunk.length;
      if (total > size) inflate.destroy();
      else queue.push(chunk);
    });
    inflate.on("error", (err) => {
      failure = failure || err;
    });

    function check() {
      if (total > size) throw new CorruptError(what + " is larger than its header says");
      if (failure) {
        if (!/^Z_/.test(failure.code || "")) throw failure;
        throw new CorruptError(what + " is not valid compressed data (" + failure.message + ")");
      }
    }

    try {
      let wanted;
      for (let ended = false; !ended; wanted = total === size ? TAIL : undefined) {
        const next = await iterator.next(wanted);
        if (next.done) throw new CorruptError(what + " is cut short");

        for (let at = 0; at < next.value.length && !ended; at += PIECE) {
          const piece = next.value.subarray(at, at + PIECE);
          fed += piece.length;
          await write(inflate, piece);
          check();
          while (queue.length) yield queue.shift();

          // zlib leaves input it has no use for once its stream is over
          ended = inflate.bytesWritten < fed;
        }
      }
    } finally {
      inflate.destroy();
      if (iterator.return) iterator.return().catch(() => {});
    }

    if (total !== size) throw new CorruptError(what + " is smaller than its header says");
  }

  return { output: output(), consumed: () => (inflate ? inflate.bytesWritten : 0) };
}

module.exports = inflateStream;
