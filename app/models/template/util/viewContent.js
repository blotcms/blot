// A view's source is stored in its hash (key.view) in one of two forms:
//
// - content: the source as written, for a short view, or one saved before
//   views were compressed;
// - contentBr: the source compressed with Brotli.
//
// A hash holds one or the other. Every stock template a blog installs or
// copies keeps its own copy of the same views, so most of the bytes are the
// same few templates over and over; compressed, the views take about two
// fifths of the memory they did (measured on the 28 Nov 2026 backup, #3014).
//
// getView reads view hashes as Buffers (the compressed field is binary) and
// unpacks them here into the plain view every caller uses. Nothing else may
// read a view hash: the client-side cache (models/redis-cache) keys a reply by
// the command alone, not the type it was decoded as, so a read decoding the
// fields as strings would be served Buffers, or the binary field mangled.
const zlib = require("zlib");
const { promisify } = require("util");

const brotliCompress = promisify(zlib.brotliCompress);
const brotliDecompress = promisify(zlib.brotliDecompress);

const FIELD = "contentBr";

// Shorter sources stay plain: a view hash with only short fields is stored
// compactly by Redis (a listpack) and compressing would save little
const MIN_BYTES = 256;

// Quality 5 compresses about as well as 9 at a quarter of the time (a whole
// large template, 1 MB of views, in about 60 ms) and decompresses as fast
const QUALITY = 5;

// Partials are read one after another, so each view a render reads waits for
// its own decompression. Through the thread pool that took about 1 ms a view
// on a cold render (25 ms for a large template's 20 views), against well
// under 0.1 ms in the thread for a typical view. So a view is decompressed
// in the thread unless it is large enough to hold the event loop up
// (32 KB compressed is about 150 KB of source, about 0.5 ms).
const SYNC_MAX_BYTES = 32 * 1024;

// Resolves with the compressed source, or null to store it as written
async function pack(content) {
  if (typeof content !== "string") return null;

  const source = Buffer.from(content, "utf8");

  if (source.length < MIN_BYTES) return null;

  const packed = await brotliCompress(source, {
    params: {
      [zlib.constants.BROTLI_PARAM_QUALITY]: QUALITY,
      [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
      [zlib.constants.BROTLI_PARAM_SIZE_HINT]: source.length,
    },
  });

  return packed.length < source.length ? packed : null;
}

// A reply from the client-side cache is a structuredClone of the Buffer it
// holds, which comes back as a plain Uint8Array
function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array)
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  return Buffer.from(String(value), "utf8");
}

function toText(value) {
  if (typeof value === "string") return value;
  return toBuffer(value).toString("utf8");
}

// Turns a view hash read as Buffers into strings, with the source unpacked
// into content. Resolves with a new object.
async function unpack(hash) {
  const view = {};

  for (const field of Object.keys(hash)) {
    if (field === FIELD) continue;
    view[field] = toText(hash[field]);
  }

  // setView and the backfill each leave one of the two fields, in one
  // MULTI or script. Were both ever there, content would be what was written.
  if (hash[FIELD] !== undefined && view.content === undefined) {
    const packed = toBuffer(hash[FIELD]);
    const source =
      packed.length <= SYNC_MAX_BYTES
        ? zlib.brotliDecompressSync(packed)
        : await brotliDecompress(packed);
    view.content = source.toString("utf8");
  }

  return view;
}

module.exports = { FIELD, pack, unpack };
