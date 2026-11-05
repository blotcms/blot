var { NotFoundError } = require("./errors");

// Every read and write of a blog's folder (the files its owner syncs) goes
// through this module, the way generated assets go through storage/assets.
// Callers name a file by (blogID, path), where path is relative to the blog's
// folder: "/posts/a.txt" and "posts/a.txt" are the same file, and ".." cannot
// leave the folder. See README for what the module does.
//
// This file is the public surface only. A blog's folder lives in the storage
// bucket, as the objects under {blogID}/folder/, with its metadata in
// models/file and recently read bytes in the content cache on the instance
// store (./s3.js, ./cache.js). In development and in specs the bucket is
// MinIO.
//
// Missing files reject with NotFoundError (code "ENOENT").

// Loaded when a call is made rather than when this file loads, so requiring
// storage/folder doesn't load models/file and its Redis client with it
function backend() {
  return require("./s3");
}

function delegate(name) {
  return function () {
    return backend()[name].apply(null, arguments);
  };
}

module.exports = {
  NotFoundError,

  // Resolves to a Buffer
  read: delegate("read"),

  // A readable stream of the file's bytes, or of an inclusive byte range:
  // { start, end }, as fs.createReadStream takes. Failures (NotFoundError)
  // are emitted as the stream's "error" event, never thrown.
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
  // { modified } (ms) gives the file that modified time.
  writeFrom: delegate("writeFrom"),

  // For tools which insist on writing to a path themselves (pandoc, sharp's
  // toFile): create the parent directory of await path(blogID, p), write to it,
  // then call commit(blogID, p) once the file is complete. commit is where the
  // file is uploaded, so a tool must not touch the path afterwards.
  path: delegate("path"),
  commit: delegate("commit"),

  // Resolves to a real local path holding the file, for tools which read from
  // a path (hashing, sharp, pandoc). Read-only by contract: the caller must
  // not modify or delete it, because it is a cache entry, which may be
  // evicted once it is no longer recent, so use the path straight away.
  ensureLocal: delegate("ensureLocal"),

  // Calls fn(localPath) with the same kind of path as ensureLocal, and
  // resolves to what fn resolves to. For tools which may run for a long time
  // (pandoc, sharp, a big upload): the cache entry is pinned, in every process
  // sharing the cache, until the promise fn returns has settled, so it cannot
  // be evicted under the tool. The path is read-only and must not be used
  // after fn is done.
  withLocal: delegate("withLocal"),

  mkdir: delegate("mkdir"),

  // Removes a directory and everything in it (a prefix delete)
  rmdir: delegate("rmdir"),

  // Removes a file or a directory. A missing path is not an error.
  remove: delegate("remove"),

  // Moves a file or a directory, replacing a file or directory of the same
  // kind at the destination and creating its parents
  move: delegate("move"),

  // { isDirectory, size, modified }, with modified in milliseconds since the
  // epoch and size 0 for a directory. A file also gets hash when called with
  // { hash: true }: Dropbox's content_hash (helper/hashFile), which costs a
  // download, so only callers which need it ask. With { sha1: true } a file
  // also gets sha1, the SHA-1 of its bytes in hex (as entries' contentHash
  // uses), from the index at no cost.
  stat: delegate("stat"),

  // Resolves to a boolean
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
  // without sizes or times
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
