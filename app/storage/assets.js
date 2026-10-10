var config = require("config");
var { blog_static_files_dir } = config;
var ensure = require("helper/ensure");
var fs = require("fs-extra");
var { join, dirname, resolve, sep } = require("path");

// Every per-blog generated asset (thumbnails, image cache, converter output,
// avatars, template uploads, ...) lives under blog_static_files_dir/{blogID}.
// This module is the single choke point for reading, writing, deleting,
// listing and serving those files. Everything below is the local-disk
// implementation; a later change swaps in object storage behind the same
// functions (see README).
//
// Callers name a file by (blogID, relPath), where relPath is relative to the
// blog's asset directory, e.g. "_thumbnails/{uuid}/small.jpg". A leading "/"
// is allowed (so req.baseUrl + req.path can be passed straight in) and is
// ignored. Every relPath goes through the same escape guard as path().
//
// Tools that insist on writing to a local path themselves (sharp's toFile,
// pandoc --extract-media, puppeteer) write to path(blogID, relPath) and then
// call commit(blogID, relPath) once the file or directory is in its final
// place. Everything else uses write() or writeFrom().

// The one signal for "no such file", whatever the backend. It carries
// code "ENOENT" so existing err.code checks keep working.
class NotFoundError extends Error {
  constructor(message) {
    super(message || "Not found");
    this.name = "NotFoundError";
    this.code = "ENOENT";
    this.status = 404;
  }
}

function root(blogID) {
  ensure(blogID, "string");

  if (!blogID) throw new Error("storage/assets: blogID must be a non-empty string");

  return join(blog_static_files_dir, blogID);
}

// Builds an absolute local path inside a blog's asset directory. With no
// segments this returns the directory itself. Throws if the joined path would
// resolve outside of it (e.g. a segment of "../").
function path(blogID, ...segments) {
  var base = root(blogID);

  if (!segments.length) return base;

  var full = join(base, ...segments);

  if (full !== base && full.indexOf(base + sep) !== 0) {
    throw new Error(
      "storage/assets: path escapes blog's asset directory: " +
        segments.join("/")
    );
  }

  return full;
}

function strip(relPath) {
  ensure(relPath, "string");
  return relPath.replace(/^\/+/, "");
}

function isMissing(err) {
  return (
    err &&
    (err.code === "ENOENT" ||
      err.code === "ENOTDIR" ||
      err.code === "EISDIR" ||
      err.status === 404)
  );
}

function notFound(blogID, relPath, err) {
  var error = new NotFoundError(
    "storage/assets: not found: " + blogID + "/" + strip(relPath)
  );
  if (err) error.cause = err;
  return error;
}

// The public CDN URL of an asset. Names are used as given; callers which
// URL-encode their filenames encode them before passing them in.
function url(blogID, relPath) {
  path(blogID, relPath);
  return config.cdn.origin + "/" + blogID + "/" + strip(relPath);
}

// Called after a file (or directory tree) has been written to
// path(blogID, relPath) by a tool that needed a local path. On local disk
// the file is already where it belongs, so there is nothing to do. Nothing
// existing at relPath (e.g. a converter whose document had no media) is
// not an error.
async function commit(blogID, relPath) {
  path(blogID, relPath);
}

// Writes a Buffer or string, then commits it.
async function write(blogID, relPath, data) {
  await fs.outputFile(path(blogID, relPath), data);
  await commit(blogID, relPath);
}

// Copies (or, with move: true, moves) a local file into place, then commits
// it. overwrite is passed to fs-extra, so by default a copy replaces an
// existing file and a move refuses to.
async function writeFrom(blogID, relPath, srcPath, options) {
  options = options || {};

  var destination = path(blogID, relPath);
  var fsOptions = {};

  if (options.overwrite !== undefined) fsOptions.overwrite = options.overwrite;

  await fs.ensureDir(dirname(destination));

  if (options.move) await fs.move(srcPath, destination, fsOptions);
  else await fs.copy(srcPath, destination, fsOptions);

  await commit(blogID, relPath);
}

async function read(blogID, relPath) {
  try {
    return await fs.readFile(path(blogID, relPath));
  } catch (err) {
    if (isMissing(err)) throw notFound(blogID, relPath, err);
    throw err;
  }
}

async function exists(blogID, relPath) {
  return fs.pathExists(path(blogID, relPath));
}

// Names of the immediate children of a directory, or [] if it doesn't exist.
async function list(blogID, relDir) {
  try {
    return await fs.readdir(path(blogID, relDir || ""));
  } catch (err) {
    if (isMissing(err)) return [];
    throw err;
  }
}

// Every file in a blog's asset scope, as relPaths with no leading slash.
async function* walk(blogID) {
  var base = root(blogID);

  async function* visit(directory) {
    var entries;

    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (err) {
      if (isMissing(err)) return;
      throw err;
    }

    for (var entry of entries) {
      var full = join(directory, entry.name);

      if (entry.isDirectory()) yield* visit(full);
      else if (entry.isFile()) yield full.slice(base.length + 1).split(sep).join("/");
    }
  }

  yield* visit(base);
}

function createReadStream(blogID, relPath) {
  return fs.createReadStream(path(blogID, relPath));
}

// Resolves to an absolute local path which holds the file, for callers which
// need a real file (hashing, sharp input). The caller must not modify or
// delete it.
async function ensureLocal(blogID, relPath) {
  var local = path(blogID, relPath);

  try {
    await fs.stat(local);
  } catch (err) {
    if (isMissing(err)) throw notFound(blogID, relPath, err);
    throw err;
  }

  return local;
}

// Sends an asset as the response. Range requests, ETag, Last-Modified and
// content-type come from res.sendFile. Rejects with NotFoundError if the
// asset doesn't exist so callers can fall through or send a 404.
//   maxAge     milliseconds or an ms string, e.g. "1y"
//   immutable  adds the immutable Cache-Control directive
//   headers    extra response headers (they win over the defaults)
//   dotfiles   "allow" (default) or "ignore" to treat dotfiles as missing
async function serve(req, res, blogID, relPath, options) {
  options = options || {};

  // Throws if relPath tries to leave the blog's asset directory
  path(blogID, relPath);

  var sendOptions = {
    root: root(blogID),
    dotfiles: options.dotfiles || "allow",
  };

  if (options.maxAge !== undefined) sendOptions.maxAge = options.maxAge;
  if (options.immutable !== undefined) sendOptions.immutable = options.immutable;
  if (options.headers) sendOptions.headers = options.headers;

  return new Promise(function (resolve, reject) {
    res.sendFile(strip(relPath), sendOptions, function (err) {
      if (!err) return resolve();
      if (isMissing(err)) return reject(notFound(blogID, relPath, err));
      reject(err);
    });
  });
}

// Removes a file or a whole directory. A missing path is not an error.
async function remove(blogID, relPath) {
  var local = path(blogID, relPath);

  // An empty relPath would be a scope-wide delete, which only removeAll does
  if (resolve(local) === resolve(root(blogID))) {
    throw new Error("storage/assets: remove needs a path inside the blog's asset directory");
  }

  await fs.remove(local);
}

// Removes a blog's entire asset directory. This is only used by blog
// deletion. Preserves the realpath safety check that used to live in
// app/models/blog/remove.js's safelyRemove: resolve both realpaths and make
// sure the folder is strictly inside blog_static_files_dir before removing.
async function removeAll(blogID) {
  var folder = root(blogID);
  var realpathToFolder;

  try {
    realpathToFolder = await fs.realpath(folder);
  } catch (err) {
    // This folder does not exist, so no need to do anything
    if (err.code === "ENOENT") return;
    throw err;
  }

  var realpathToRoot = await fs.realpath(blog_static_files_dir);

  if (realpathToFolder.indexOf(realpathToRoot + sep) !== 0) {
    throw new Error("Could not safely remove directory: " + folder);
  }

  await fs.remove(realpathToFolder);
}

module.exports = {
  NotFoundError,
  path,
  url,
  commit,
  write,
  writeFrom,
  read,
  exists,
  list,
  walk,
  createReadStream,
  ensureLocal,
  serve,
  remove,
  removeAll,
};
