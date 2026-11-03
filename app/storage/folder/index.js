var { PassThrough, Readable } = require("stream");
var { NotFoundError } = require("./errors");
var mirror = require("./mirror");
var shadow = require("./shadow");
var primary = require("./primary");

// Every read and write of a blog's folder (the files its owner syncs) goes
// through this module, the way generated assets go through storage/assets.
// Callers name a file by (blogID, path), where path is relative to the blog's
// folder: "/posts/a.txt" and "posts/a.txt" are the same file, and ".." cannot
// leave the folder. See README for what the module does and does not do yet.
//
// This file is the public surface only. It sends each call to one of two
// backends, chosen per blog when the call is made: ./local.js keeps the
// folder on disk exactly as the app has always done, and ./s3.js keeps it in
// the storage bucket with its metadata in models/file. Every blog is on disk
// unless config.folder_primary names it (#2258 Phase D, ./primary.js), and
// even then only once S3 has a copy of it which is not behind the disk, and
// only if its client can work without the folder on disk. A blog the flag
// doesn't name costs nothing extra: no Redis, and the same calls as before.
//
// Mirroring (./mirror.js, #2258 Phase C): for the blogs config.folder_mirror
// names, every change made on disk is then made in S3 and models/file too,
// once the disk has it. Reads still come from disk, and a failure to mirror
// is logged and recorded for repair, never returned to the caller.
//
// The disk copy (./primary.js, #2258 Phase D) is the reverse, for a blog on
// S3: every change made in S3 is then made on disk too, best effort, so the
// disk stays a copy to roll back to. A blog on S3 is never mirrored.
//
// Shadow reads (./shadow.js, #2258 Phase C): for mirrored blogs, a sample
// of reads (config.folder_shadow.rate) is repeated against S3 once the disk
// has answered, to compare the results and time both. The caller gets the
// disk's answer, unchanged and undelayed, whatever S3 does. Reads which went
// to S3 in the first place are not shadowed.
//
// Missing files reject with NotFoundError (code "ENOENT"). A symlink in a
// blog folder rejects with code "ELOOP" (see local.js: the no-symlink policy
// goes away with the filesystem).

var backends = {
  local: function () {
    return require("./local");
  },
  // Loaded only when a call goes to it, so a process with every blog on
  // disk never loads it
  s3: function () {
    return require("./s3");
  },
};

// The backend a spec chose for every blog, or null to choose per blog
var chosen = null;

// Sends every blog to the "local" or "s3" backend whatever the flag says,
// with no disk copy for S3 (the mirror still follows the disk). Called with
// nothing, goes back to choosing per blog. For specs only, so the same suite
// runs against both: nothing in the app or its config calls it.
function useBackend(name) {
  if (name === undefined || name === null) {
    chosen = null;
    return;
  }

  if (!backends[name]) throw new Error("storage/folder: no backend called " + name);

  chosen = name;
}

// The backend for a call about blogID when it is known without asking Redis:
// the one a spec chose, or disk for a blog the flag doesn't name. Otherwise
// null, and backendFor asks.
function known(blogID) {
  if (chosen) return chosen;
  if (!primary.enabledFor(blogID)) return "local";
  return null;
}

// Resolves to the name of the backend calls about blogID go to now, "local"
// or "s3"
async function backendFor(blogID) {
  return known(blogID) || ((await primary.usesS3(blogID)) ? "s3" : "local");
}

// Where each function takes the blog ID
function blogOf(name, args) {
  return args[name === "serve" ? 2 : 0];
}

// Reads from disk are shadowed (./shadow.js decides which)
function invoke(name, which, args) {
  var call = backends[which]()[name];

  if (which === "local" && shadow.OPS.indexOf(name) !== -1) return shadow(name, call, args);

  return call.apply(null, args);
}

// For a blog which might be on S3: the stream is returned at once, as the
// backends return theirs, and the backend's own stream piped into it once
// the backend is known. Failures are the stream's "error" event.
function deferredStream(blogID, args) {
  var stream = new PassThrough();
  var source;

  backendFor(blogID)
    .then(function (which) {
      if (stream.destroyed) return;

      source = invoke("createReadStream", which, args);
      source.on("error", function (err) {
        stream.destroy(err);
      });
      source.pipe(stream);
    })
    .catch(function (err) {
      stream.destroy(err);
    });

  stream.on("close", function () {
    if (source) source.destroy();
  });

  return stream;
}

async function* deferredWalk(blogID, args) {
  yield* backends[await backendFor(blogID)]().walk.apply(null, args);
}

// Each function looks up the backend when called, not when this file loads
function delegate(name) {
  return function () {
    var args = Array.prototype.slice.call(arguments);
    var blogID = blogOf(name, args);
    var which = known(blogID);

    if (which) return invoke(name, which, args);
    if (name === "createReadStream") return deferredStream(blogID, args);
    if (name === "walk") return deferredWalk(blogID, args);

    return backendFor(blogID).then(function (which) {
      return invoke(name, which, args);
    });
  };
}

module.exports = {
  NotFoundError,
  useBackend,

  // Resolves to "local" or "s3", the backend calls about blogID go to now
  backendFor,

  // Resolves to a Buffer
  read: delegate("read"),

  // A readable stream of the file's bytes, or of an inclusive byte range:
  // { start, end }, as fs.createReadStream takes. Failures (NotFoundError,
  // ELOOP) are emitted as the stream's "error" event, never thrown.
  createReadStream: delegate("createReadStream"),

  // Sends the file as the response, like res.sendFile: Range, If-None-Match,
  // If-Modified-Since, ETag and Last-Modified. A path ending in "/" serves
  // that directory's index.html. Rejects with NotFoundError if there is no
  // such file, so callers can fall through or send a 404. Options:
  //   maxAge     milliseconds or an ms string, e.g. "1y"
  //   immutable  adds the immutable Cache-Control directive
  //   headers    extra response headers (they win over the defaults)
  //   dotfiles   "allow" (default) or "ignore" to treat dotfiles as missing
  serve: delegate("serve"),

  // data is a Buffer, a string or a readable stream. Parent directories are
  // created, and a file already at path is replaced.
  write: delegate("write"),

  // Copies (or, with { move: true }, moves) a local file in, replacing any
  // file already at path. The source is the caller's own, never a blog path.
  // { modified } (ms) gives the file that modified time, for copying a file
  // from one backend to the other.
  writeFrom: delegate("writeFrom"),

  // For tools which insist on writing to a path themselves (pandoc, sharp's
  // toFile): create the parent directory of await path(blogID, p), write to it,
  // then call commit(blogID, p) once the file is complete. commit is where an S3
  // backend uploads, so a tool must not touch the path afterwards.
  path: delegate("path"),
  commit: delegate("commit"),

  // Resolves to a real local path holding the file, for tools which read from
  // a path (hashing, sharp, pandoc). Read-only by contract: the caller must
  // not modify or delete it, because on S3 it is a cache entry, which may be
  // evicted once it is no longer recent, so use the path straight away.
  ensureLocal: delegate("ensureLocal"),

  mkdir: delegate("mkdir"),

  // Removes a directory and everything in it (a prefix delete on S3)
  rmdir: delegate("rmdir"),

  // Removes a file or a directory. A missing path is not an error.
  remove: delegate("remove"),

  // Moves a file or a directory, replacing a file or directory of the same
  // kind at the destination and creating its parents
  move: delegate("move"),

  // { isDirectory, size, modified }, with modified in milliseconds since the
  // epoch and size 0 for a directory. A file also gets hash when called with
  // { hash: true }: Dropbox's content_hash (helper/hashFile). It is opt-in
  // because on the local backend computing it reads the whole file, so only
  // callers which need it ask. On S3 it costs a download. With
  // { sha1: true } a file also gets sha1, the SHA-1 of its bytes in hex (as
  // entries' contentHash uses): read from the file on the local backend, and
  // from the index at no cost on S3.
  stat: delegate("stat"),

  // Resolves to a boolean. A symlink counts as missing.
  exists: delegate("exists"),

  // One page of a directory, sorted by name:
  //   { entries: [{ name, isDirectory, size, modified }], cursor }
  // cursor is opaque: pass it back for the next page; null means that was the
  // last. Options: { cursor, limit } (limit defaults to 1000).
  list: delegate("list"),

  // An async iterator of the paths below dir, depth first and sorted by name,
  // as "/a/b.txt" paths relative to the blog folder. Only the directory being
  // read is held in memory. Yields files only, unless { directories: true },
  // which also yields each directory before its contents.
  walk: delegate("walk"),

  // [{ name, isDirectory }] for every entry of a directory, sorted by name,
  // without sizes or times: one read of the directory and no stat per entry
  listNames: delegate("listNames"),

  // Every entry of a directory, for callers which can afford the whole thing
  listAll: delegate("listAll"),

  // Resolves to the path of the entry which path names ignoring case, spelled
  // as it is stored ("/Templates/a.css"), or rejects with NotFoundError. If
  // several entries differ only by case, the exact name wins, otherwise the
  // first in the directory's listing order, as helper/caseSensitivePath does.
  // Nothing may assume a lowercased name is unique.
  resolveCaseInsensitive: delegate("resolveCaseInsensitive"),

  // Removes the whole folder of a blog, for blog deletion
  removeAll: delegate("removeAll"),
};

// The calls which change a folder. A change made on disk is mirrored to S3
// once it has succeeded (./mirror.js, which decides per blog whether to),
// and one made in S3 for a blog on S3 is copied to disk (./primary.js).
// Neither rejects. path() changes nothing; the file a tool writes there is
// copied by commit().
var MUTATIONS = ["write", "writeFrom", "commit", "mkdir", "rmdir", "remove", "move", "removeAll"];

function noop() {}

MUTATIONS.forEach(function (name) {
  module.exports[name] = async function () {
    var args = Array.prototype.slice.call(arguments);

    // A stream written can fail while the backend is being chosen (a Redis
    // round trip for a named blog), and an "error" with no listener would
    // take down the process. The backends check data.errored before reading
    // it, so the write still rejects with the stream's error.
    if (name === "write" && args[2] instanceof Readable) args[2].on("error", noop);

    var which = await backendFor(args[0]);
    var result = await backends[which]()[name].apply(null, args);

    if (which === "local") await mirror(name, args);
    else if (!chosen) await primary.copy(name, args);

    return result;
  };
});
