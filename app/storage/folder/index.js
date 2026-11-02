var { NotFoundError } = require("./errors");
var mirror = require("./mirror");

// Every read and write of a blog's folder (the files its owner syncs) goes
// through this module, the way generated assets go through storage/assets.
// Callers name a file by (blogID, path), where path is relative to the blog's
// folder: "/posts/a.txt" and "posts/a.txt" are the same file, and ".." cannot
// leave the folder. See README for what the module does and does not do yet.
//
// This file is the public surface only. Every blog uses ./local.js, which
// keeps the folder on disk exactly as the app has always done. ./s3.js keeps
// it in the storage bucket with its metadata in models/file; it is built and
// passes the same specs, but nothing selects it yet (#2258 Phase C). Each
// call goes to whichever backend is current when it is made.
//
// Mirroring (./mirror.js, #2258 Phase C): for the blogs config.folder_mirror
// names, every change made on disk is then made in S3 and models/file too,
// once the disk has it. Reads still come from disk, and a failure to mirror
// is logged and recorded for repair, never returned to the caller.
//
// Missing files reject with NotFoundError (code "ENOENT"). A symlink in a
// blog folder rejects with code "ELOOP" (see local.js: the no-symlink policy
// goes away with the filesystem).

var backends = {
  local: function () {
    return require("./local");
  },
  // Loaded only when selected, so the app never loads it today
  s3: function () {
    return require("./s3");
  },
};

var backend = backends.local();

// Switches every blog to the "local" or "s3" backend. For specs only, so the
// same suite runs against both: nothing in the app or its config calls it.
// Choosing a backend per blog comes in Phase D.
function useBackend(name) {
  if (!backends[name]) throw new Error("storage/folder: no backend called " + name);

  backend = backends[name]();
}

// Each function looks up the backend when called, not when this file loads
function delegate(name) {
  return function () {
    return backend[name].apply(null, arguments);
  };
}

module.exports = {
  NotFoundError,
  useBackend,

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

// The calls which change a folder. While the local backend is current, each
// is mirrored once it has succeeded on disk (see ./mirror.js, which decides
// per blog whether to and never rejects). path() changes nothing; the file a
// tool writes there is mirrored by commit().
var MUTATIONS = ["write", "writeFrom", "commit", "mkdir", "rmdir", "remove", "move", "removeAll"];

MUTATIONS.forEach(function (name) {
  var call = module.exports[name];

  module.exports[name] = async function () {
    var args = Array.prototype.slice.call(arguments);
    var mirrored = backend === backends.local();
    var result = await call.apply(null, args);

    if (mirrored) await mirror(name, args);

    return result;
  };
});
