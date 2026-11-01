var local = require("./local");
var { NotFoundError } = require("./errors");

// Every read and write of a blog's folder (the files its owner syncs) goes
// through this module, the way generated assets go through storage/assets.
// Callers name a file by (blogID, path), where path is relative to the blog's
// folder: "/posts/a.txt" and "posts/a.txt" are the same file, and ".." cannot
// leave the folder. See README for what the module does and does not do yet.
//
// This file is the public surface only. The one backend, ./local.js, keeps
// the folder on disk exactly as the app has always done. An S3 backend will
// sit behind these same functions later, so callers never change.
//
// Missing files reject with NotFoundError (code "ENOENT"). A symlink in a
// blog folder rejects with code "ELOOP" (see local.js: the no-symlink policy
// goes away with the filesystem).

module.exports = {
  NotFoundError,

  // Resolves to a Buffer
  read: local.read,

  // A readable stream of the file's bytes, or of an inclusive byte range:
  // { start, end }, as fs.createReadStream takes. Failures (NotFoundError,
  // ELOOP) are emitted as the stream's "error" event, never thrown.
  createReadStream: local.createReadStream,

  // Sends the file as the response, like res.sendFile: Range, If-None-Match,
  // If-Modified-Since, ETag and Last-Modified. A path ending in "/" serves
  // that directory's index.html. Rejects with NotFoundError if there is no
  // such file, so callers can fall through or send a 404. Options:
  //   maxAge     milliseconds or an ms string, e.g. "1y"
  //   immutable  adds the immutable Cache-Control directive
  //   headers    extra response headers (they win over the defaults)
  //   dotfiles   "allow" (default) or "ignore" to treat dotfiles as missing
  serve: local.serve,

  // data is a Buffer, a string or a readable stream. Parent directories are
  // created, and a file already at path is replaced.
  write: local.write,

  // Copies (or, with { move: true }, moves) a local file in, replacing any
  // file already at path. The source is the caller's own, never a blog path.
  writeFrom: local.writeFrom,

  // For tools which insist on writing to a path themselves (pandoc, sharp's
  // toFile): create the parent directory of await path(blogID, p), write to it,
  // then call commit(blogID, p) once the file is complete. commit is where an S3
  // backend uploads, so a tool must not touch the path afterwards.
  path: local.path,
  commit: local.commit,

  // Resolves to a real local path holding the file, for tools which read from
  // a path (hashing, sharp, pandoc). Read-only by contract: the caller must
  // not modify or delete it, because on S3 it is a cache entry.
  ensureLocal: local.ensureLocal,

  mkdir: local.mkdir,

  // Removes a directory and everything in it (a prefix delete on S3)
  rmdir: local.rmdir,

  // Removes a file or a directory. A missing path is not an error.
  remove: local.remove,

  // Moves a file or a directory, replacing a file or directory of the same
  // kind at the destination and creating its parents
  move: local.move,

  // { isDirectory, size, modified }, with modified in milliseconds since the
  // epoch and size 0 for a directory. A file also gets hash when called with
  // { hash: true }: Dropbox's content_hash (helper/hashFile). It is opt-in
  // because on the local backend computing it reads the whole file, so only
  // callers which need it ask. On S3 it comes from the index at no cost.
  stat: local.stat,

  // Resolves to a boolean. A symlink counts as missing.
  exists: local.exists,

  // One page of a directory, sorted by name:
  //   { entries: [{ name, isDirectory, size, modified }], cursor }
  // cursor is opaque: pass it back for the next page; null means that was the
  // last. Options: { cursor, limit } (limit defaults to 1000).
  list: local.list,

  // An async iterator of the paths below dir, depth first and sorted by name,
  // as "/a/b.txt" paths relative to the blog folder. Only the directory being
  // read is held in memory. Yields files only, unless { directories: true },
  // which also yields each directory before its contents.
  walk: local.walk,

  // [{ name, isDirectory }] for every entry of a directory, sorted by name,
  // without sizes or times: one read of the directory and no stat per entry
  listNames: local.listNames,

  // Every entry of a directory, for callers which can afford the whole thing
  listAll: local.listAll,

  // Resolves to the path of the entry which path names ignoring case, spelled
  // as it is stored ("/Templates/a.css"), or rejects with NotFoundError. If
  // several entries differ only by case, the exact name wins, otherwise the
  // first in the directory's listing order, as helper/caseSensitivePath does.
  // Nothing may assume a lowercased name is unique.
  resolveCaseInsensitive: local.resolveCaseInsensitive,

  // Removes the whole folder of a blog, for blog deletion
  removeAll: local.removeAll,
};
