// Reads a zip archive (the input), in the jail or in-process (see ../index.js).
// The archive is hostile, and so are the args, which come from a process we
// treat as less trusted than this one, so they are checked here too:
//
//   { maxEntries, maxBytes, maxRatio }
//
// maxEntries is how many records (directories included) may be walked,
// maxBytes how many uncompressed bytes the files may add up to, and maxRatio
// how much more than the archive's own size they may add up to (kept out of
// the way of small archives: see RATIO_FLOOR). Each is capped by HARD below.
//
// The outputs are the files' contents, in archive order, and meta is
//
//   { error: null, files: ["index.html", "css/style.css"] }
//
// with one path per output. A bad archive is not a thrown error, since the
// jail's stderr is cut short and never reaches the caller: it is
//
//   { error: { reason, path? }, files: [] }
//
// with no outputs. The reasons are zip (not an archive), read (the archive or
// an entry could not be read: damaged, encrypted, a method we don't have),
// count, size (more than it declares, or than we allow), ratio, path (absolute,
// upward, or with characters no file name has) and symlink. Directories are
// not returned, and the caller writes the files itself, so it still has to
// keep every path inside the directory it writes to.

const yauzl = require("yauzl");

const MiB = 1024 * 1024;

// What no caller may raise: the jail's output limit (proxy/unit/sandbox/jail.js)
// less room for the paths, and what a reply may hold (app/sandbox/index.js)
const HARD = { maxEntries: 10 * 1000, maxBytes: 56 * MiB, maxRatio: 1000 };

// A ratio of a few bytes to a few kilobytes means nothing. Below this much
// output only maxBytes applies.
const RATIO_FLOOR = 1 * MiB;

const SYMLINK = 0o120000;
const FILE_TYPE = 0o170000;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\x00-\x1f\x7f]/;

class Refusal extends Error {
  constructor(reason, path) {
    super(reason);
    this.reason = reason;
    this.path = path;
  }
}

function limit(value, max) {
  if (!Number.isInteger(value) || value < 1 || value > max) throw new Error("invalid limits");
  return value;
}

function checkPath(name) {
  // Windows tools write backslashes, and a drive letter is as absolute as a slash
  if (/^([/\\]|[a-zA-Z]:)/.test(name)) throw new Refusal("path", name);
  if (CONTROL_CHARACTERS.test(name)) throw new Refusal("path", name);
  if (name.split(/[/\\]/).includes("..")) throw new Refusal("path", name);
}

function isSymlink(entry) {
  return ((entry.externalFileAttributes >>> 16) & FILE_TYPE) === SYMLINK;
}

function readEntry(zipfile, entry, over) {
  return new Promise((resolve, reject) => {
    zipfile.openReadStream(entry, (err, stream) => {
      if (err) return reject(new Refusal("read", entry.fileName));
      const chunks = [];
      let size = 0;
      stream.on("data", (chunk) => {
        size += chunk.length;
        // The header can lie about uncompressedSize, so cap what is read
        const reason = over(size);
        if (reason) {
          stream.destroy();
          return reject(new Refusal(reason, entry.fileName));
        }
        chunks.push(chunk);
      });
      stream.on("error", () => reject(new Refusal("read", entry.fileName)));
      stream.on("end", () => resolve(Buffer.concat(chunks)));
    });
  });
}

function open(input) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(input, { lazyEntries: true }, (err, zipfile) =>
      err ? reject(new Refusal("zip")) : resolve(zipfile)
    );
  });
}

// Reads the next record; null at the end
function next(zipfile) {
  return new Promise((resolve, reject) => {
    const onEntry = (entry) => {
      cleanup();
      resolve(entry);
    };
    const onEnd = () => {
      cleanup();
      resolve(null);
    };
    // yauzl refuses these names itself, before checkPath sees them
    const onError = (err) => {
      cleanup();
      reject(new Refusal(/^(invalid characters|absolute path|invalid relative path)/.test(err.message) ? "path" : "read"));
    };
    const cleanup = () => {
      zipfile.removeListener("entry", onEntry);
      zipfile.removeListener("end", onEnd);
      zipfile.removeListener("error", onError);
    };
    zipfile.on("entry", onEntry);
    zipfile.on("end", onEnd);
    zipfile.on("error", onError);
    zipfile.readEntry();
  });
}

async function extract(input, { maxEntries, maxBytes, maxRatio }) {
  const zipfile = await open(input);
  const files = [];
  const outputs = [];
  let scanned = 0;
  let declared = 0;
  let total = 0;

  // Why a file with this many bytes read so far is too much, if it is: the
  // byte cap, or the ratio against this archive, which is never under the floor
  const over = (size) => {
    if (total + size > maxBytes) return "size";
    if (total + size > Math.max(RATIO_FLOOR, input.length * maxRatio)) return "ratio";
    return null;
  };

  try {
    for (let entry = await next(zipfile); entry; entry = await next(zipfile)) {
      // Every record counts, not only files: a tree of empty directories
      // costs almost nothing to store but still has to be walked
      if (++scanned > maxEntries) throw new Refusal("count");

      checkPath(entry.fileName);
      if (entry.fileName.endsWith("/")) continue;
      if (isSymlink(entry)) throw new Refusal("symlink", entry.fileName);

      declared += entry.uncompressedSize || 0;
      if (declared > maxBytes) throw new Refusal("size", entry.fileName);

      const buffer = await readEntry(zipfile, entry, over);
      total += buffer.length;
      files.push(entry.fileName);
      outputs.push(buffer);
    }
  } finally {
    zipfile.close();
  }

  return { files, outputs };
}

async function run(args, input) {
  if (!args || typeof args !== "object") throw new Error("invalid arguments");
  const limits = {
    maxEntries: limit(args.maxEntries, HARD.maxEntries),
    maxBytes: limit(args.maxBytes, HARD.maxBytes),
    maxRatio: limit(args.maxRatio, HARD.maxRatio),
  };

  try {
    const { files, outputs } = await extract(input, limits);
    return { meta: { error: null, files }, outputs };
  } catch (err) {
    if (!(err instanceof Refusal)) throw err;
    const error = { reason: err.reason };
    if (err.path) error.path = err.path.slice(0, 200);
    return { meta: { error, files: [] }, outputs: [] };
  }
}

module.exports = { run, HARD, RATIO_FLOOR };
