var config = require("config");
var ensure = require("helper/ensure");
var pathNormalizer = require("helper/pathNormalizer");
var assertNoSymlinks = require("helper/assertNoSymlinks");
var caseSensitivePath = require("helper/caseSensitivePath");
var hashFile = require("helper/hashFile");
var sha1File = require("util").promisify(require("helper/transformer/hash"));
var fs = require("fs-extra");
var { randomUUID: uuid } = require("crypto");
var { pipeline } = require("stream/promises");
var { PassThrough, Readable } = require("stream");
var { join, dirname, relative, resolve, sep } = require("path");
var { NotFoundError } = require("./errors");

// The local-disk backend of storage/folder: a blog's folder is the directory
// {blog_folder_dir}/{blogID}, exactly as the rest of the app has always used
// it. Paths are normalised by helper/pathNormalizer, the same way as
// everywhere else, and ".." is clamped inside the blog's folder.
//
// The no-symlink policy lives here, and only here. A symlink inside a blog
// folder could expose a file outside it, so every operation which reads or
// writes through a path first runs helper/assertNoSymlinks on it (code
// "ELOOP"), and listing and walking skip symlinks instead of following them.
// All of this goes away with the filesystem when the folder moves to S3,
// where there are no links.

function noop() {}

var DEFAULT_LIMIT = 1000;
var STAT_BATCH = 64;

// Joins a blog path onto the blog's folder on disk. Resolving the path against
// the folder's root first means a path with too many ".." cannot produce
// anything outside the folder.
function localPath(blogID, path) {
  if (!path) path = "/";

  path = pathNormalizer(path);

  var root = join(config.blog_folder_dir, blogID);

  path = resolve(root, path);
  path = join(root, path);

  return path;
}

// Resolves a blog and a path to its folder and an absolute local path inside
// it. Blog IDs are not user input, but they must still be one path segment.
function locate(blogID, relPath) {
  ensure(blogID, "string");

  if (!blogID) throw new Error("storage/folder: blogID must be a non-empty string");

  var base = join(config.blog_folder_dir);
  var root = join(base, blogID);

  if (dirname(root) !== base) {
    throw new Error("storage/folder: invalid blogID: " + blogID);
  }

  var local = localPath(blogID, relPath || "/");

  // localPath cannot return anything else, but this is the choke point
  if (local !== root && local.indexOf(root + sep) !== 0) {
    throw new Error("storage/folder: path escapes blog's folder: " + relPath);
  }

  return { root: root, local: local };
}

function isMissing(err) {
  return err && (err.code === "ENOENT" || err.code === "ENOTDIR");
}

// A missing file is always a NotFoundError (code "ENOENT")
function mapError(err) {
  if (err instanceof NotFoundError) return err;
  if (isMissing(err)) return new NotFoundError(err.message);
  return err;
}

// Rejects with ELOOP for a symlink. A path below a file is a missing one.
async function guard(root, local) {
  try {
    await assertNoSymlinks(root, local);
  } catch (err) {
    throw mapError(err);
  }
}

// Everything except a missing file is the caller's to handle
async function attempt(promise) {
  try {
    return await promise;
  } catch (err) {
    throw mapError(err);
  }
}

// Directory entries sort by plain code-unit order, so a cursor is just the
// last name of the previous page
function byName(a, b) {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

function encodeCursor(name) {
  return Buffer.from(JSON.stringify({ after: name })).toString("base64url");
}

function decodeCursor(cursor) {
  try {
    var after = JSON.parse(Buffer.from(String(cursor), "base64url").toString()).after;
    if (typeof after === "string") return after;
  } catch (e) {}

  throw new Error("storage/folder: invalid cursor");
}

// What a directory entry is without following symlinks: "dir", "file", "link"
// or "other". Listings say so already unless the filesystem doesn't report
// types, in which case ask about just this one entry.
async function kind(dir, entry) {
  if (entry.isDirectory()) return "dir";
  if (entry.isSymbolicLink()) return "link";
  if (entry.isFile()) return "file";

  try {
    var stat = await fs.lstat(join(dir, entry.name));
    return stat.isDirectory() ? "dir" : stat.isSymbolicLink() ? "link" : stat.isFile() ? "file" : "other";
  } catch (e) {
    return "other";
  }
}

async function read(blogID, relPath) {
  var { root, local } = locate(blogID, relPath);

  await guard(root, local);

  return attempt(fs.readFile(local));
}

// The stream is returned at once, so the symlink check and the open happen
// when it starts, and any failure is emitted as its "error" event.
function createReadStream(blogID, relPath, options) {
  var located = locate(blogID, relPath);
  var range = {};
  var source;
  var stream = new PassThrough();

  if (options && options.start !== undefined) range.start = options.start;
  if (options && options.end !== undefined) range.end = options.end;

  guard(located.root, located.local)
    .then(function () {
      if (stream.destroyed) return;

      // Throws straight away on an invalid range
      source = fs.createReadStream(located.local, range);
      source.on("error", function (err) {
        stream.destroy(mapError(err));
      });
      source.pipe(stream);
    })
    .catch(function (err) {
      stream.destroy(mapError(err));
    });

  stream.on("close", function () {
    if (source) source.destroy();
  });

  return stream;
}

// Sends the file like res.sendFile does for blog-folder files in
// blog/routes/assets.js: dotfiles allowed, Range and conditional requests
// handled by send.
async function serve(req, res, blogID, relPath, options) {
  options = options || {};

  var { root, local } = locate(blogID, relPath);

  // A trailing slash is the directory's index.html, as it is for sendFile
  if (!relPath || relPath.slice(-1) === "/") local = join(local, "index.html");

  if (
    options.dotfiles === "ignore" &&
    relative(root, local)
      .split(sep)
      .some(function (segment) {
        return segment.charAt(0) === ".";
      })
  ) {
    throw new NotFoundError();
  }

  await guard(root, local);

  var stat = await attempt(fs.stat(local));

  if (!stat.isFile()) throw new NotFoundError();

  return new Promise(function (resolve, reject) {
    res.sendFile(
      local,
      {
        maxAge: options.maxAge || 0,
        immutable: !!options.immutable,
        dotfiles: "allow",
        headers: options.headers,
      },
      function (err) {
        if (!err) return resolve();
        if (err.status === 404 || isMissing(err)) return reject(new NotFoundError(err.message));
        reject(err);
      }
    );
  });
}

async function write(blogID, relPath, data) {
  // The stream can fail during the awaits below, before pipeline listens for
  // it, and an "error" with no listener would take down the process
  if (data instanceof Readable) data.on("error", noop);

  var { root, local } = locate(blogID, relPath);

  if (local === root) throw new Error("storage/folder: write needs a path inside the folder");

  await guard(root, local);
  await fs.ensureDir(dirname(local));

  if (data instanceof Readable) {
    if (data.errored) throw mapError(data.errored);

    // A stream can fail part way, which must not cost the file already here.
    // The name is fixed length: local's own could be at the filesystem's limit.
    var tmp = join(dirname(local), ".tmp-" + uuid());

    try {
      await pipeline(data, fs.createWriteStream(tmp));
      await fs.move(tmp, local, { overwrite: true });
    } catch (err) {
      await fs.remove(tmp);
      throw err;
    }
  } else {
    await fs.writeFile(local, data);
  }
}

async function writeFrom(blogID, relPath, srcPath, options) {
  var { root, local } = locate(blogID, relPath);

  if (local === root) throw new Error("storage/folder: write needs a path inside the folder");

  await guard(root, local);
  await fs.ensureDir(dirname(local));

  if (options && options.move) await fs.move(srcPath, local, { overwrite: true });
  else await attempt(fs.copyFile(srcPath, local));
}

// On this backend the path is the file's real place, so there is nothing to
// upload. An S3 backend returns a staging path instead and uploads in commit.
// The check is here and not only in commit because a tool following a symlink
// would already have written outside the folder by then.
async function path(blogID, relPath) {
  var { root, local } = locate(blogID, relPath);

  await guard(root, local);

  return local;
}

async function commit(blogID, relPath) {
  var { root, local } = locate(blogID, relPath);

  await guard(root, local);
}

async function ensureLocal(blogID, relPath) {
  var { root, local } = locate(blogID, relPath);

  await guard(root, local);
  await attempt(fs.stat(local));

  return local;
}

async function mkdir(blogID, relPath) {
  var { root, local } = locate(blogID, relPath);

  await guard(root, local);
  await fs.ensureDir(local);
}

// Removing a path removes a link at it without following it, so only the
// ancestors are checked
async function removeLocal(blogID, relPath, onlyDirectory) {
  var { root, local } = locate(blogID, relPath);

  // Emptying the folder is not a remove: removeAll deletes the blog
  if (local === root) throw new Error("storage/folder: remove needs a path inside the folder");

  try {
    await guard(root, dirname(local));
  } catch (err) {
    // An ancestor is gone or is now a file, so this path is already missing
    if (err instanceof NotFoundError) return;
    throw err;
  }

  if (onlyDirectory) {
    var stat;

    try {
      stat = await fs.lstat(local);
    } catch (err) {
      if (isMissing(err)) return;
      throw err;
    }

    if (!stat.isDirectory()) {
      var err = new Error("Not a directory: " + relPath);
      err.code = "ENOTDIR";
      throw err;
    }
  }

  await fs.remove(local);
}

function rmdir(blogID, relPath) {
  return removeLocal(blogID, relPath, true);
}

function remove(blogID, relPath) {
  return removeLocal(blogID, relPath, false);
}

async function move(blogID, from, to) {
  var source = locate(blogID, from);
  var destination = locate(blogID, to);

  if (source.local === source.root || destination.local === destination.root) {
    throw new Error("storage/folder: move needs paths inside the folder");
  }

  await guard(source.root, dirname(source.local));
  await guard(destination.root, dirname(destination.local));
  await attempt(fs.move(source.local, destination.local, { overwrite: true }));
}

async function stat(blogID, relPath, options) {
  var { root, local } = locate(blogID, relPath);

  await guard(root, local);

  var stats = await attempt(fs.stat(local));
  var isDirectory = stats.isDirectory();
  var result = {
    isDirectory: isDirectory,
    size: isDirectory ? 0 : stats.size,
    modified: stats.mtimeMs,
  };

  if (options && options.hash && !isDirectory) {
    result.hash = await attempt(hashFile(local));
  }

  // The SHA-1 of the bytes, as entries' contentHash and the S3 backend's
  // index use (helper/transformer/hash)
  if (options && options.sha1 && !isDirectory) {
    result.sha1 = await attempt(sha1File(local));
  }

  return result;
}

async function exists(blogID, relPath) {
  try {
    await stat(blogID, relPath);
    return true;
  } catch (err) {
    if (err instanceof NotFoundError || err.code === "ELOOP") return false;
    throw err;
  }
}

async function list(blogID, relDir, options) {
  options = options || {};

  var limit = options.limit === undefined ? DEFAULT_LIMIT : options.limit;

  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("storage/folder: limit must be a positive integer");
  }

  var after = options.cursor ? decodeCursor(options.cursor) : null;
  var { root, local } = locate(blogID, relDir);

  await guard(root, local);

  // A directory is read whole, as names only. That is cheap on disk, and it is
  // the only way to sort. What is not cheap is a stat, so those are limited
  // to the page.
  var dirents = await attempt(fs.readdir(local, { withFileTypes: true }));
  var names = dirents
    .filter(function (entry) {
      return !entry.isSymbolicLink() && (after === null || entry.name > after);
    })
    .sort(byName);

  var page = names.slice(0, limit);
  var entries = [];

  for (var i = 0; i < page.length; i += STAT_BATCH) {
    var batch = await Promise.all(
      page.slice(i, i + STAT_BATCH).map(async function (entry) {
        try {
          var stats = await fs.lstat(join(local, entry.name));
          var isDirectory = stats.isDirectory();

          // Not a file or a directory, or a link made since the listing
          if (!isDirectory && !stats.isFile()) return null;

          return {
            name: entry.name,
            isDirectory: isDirectory,
            size: isDirectory ? 0 : stats.size,
            modified: stats.mtimeMs,
          };
        } catch (err) {
          // Removed since the listing
          if (isMissing(err)) return null;
          throw err;
        }
      })
    );

    entries.push(...batch.filter(Boolean));
  }

  return {
    entries: entries,
    cursor: names.length > limit ? encodeCursor(page[page.length - 1].name) : null,
  };
}

// Names and whether each is a directory, from one readdir and no stats
async function listNames(blogID, relDir) {
  var { root, local } = locate(blogID, relDir);

  await guard(root, local);

  var dirents = await attempt(fs.readdir(local, { withFileTypes: true }));
  var entries = [];

  for (var entry of dirents) {
    var type = await kind(local, entry);

    if (type === "dir" || type === "file") {
      entries.push({ name: entry.name, isDirectory: type === "dir" });
    }
  }

  return entries.sort(byName);
}

async function listAll(blogID, relDir) {
  var entries = [];
  var cursor = null;

  do {
    var page = await list(blogID, relDir, { cursor: cursor });
    entries.push(...page.entries);
    cursor = page.cursor;
  } while (cursor);

  return entries;
}

// Yields "/a/b.txt" paths, spelled as stored on disk (not run through
// localPath's normalisation, which would change a name that isn't NFC). A
// directory which vanishes mid-walk is skipped; the one asked for must exist.
async function* walk(blogID, relDir, options) {
  var { root, local } = locate(blogID, relDir);
  var directories = !!(options && options.directories);
  var start = relative(root, local).split(sep).filter(Boolean);

  await guard(root, local);

  async function* visit(current, prefix, top) {
    var entries;

    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch (err) {
      if (!top && isMissing(err)) return;
      throw mapError(err);
    }

    entries.sort(byName);

    for (var entry of entries) {
      var type = await kind(current, entry);
      var full = prefix + "/" + entry.name;

      if (type === "dir") {
        if (directories) yield full;
        yield* visit(join(current, entry.name), full, false);
      } else if (type === "file") {
        yield full;
      }
    }
  }

  yield* visit(local, start.length ? "/" + start.join("/") : "", true);
}

async function resolveCaseInsensitive(blogID, relPath) {
  var { root, local } = locate(blogID, relPath);
  var segments = relative(root, local).split(sep).filter(Boolean);
  var current = root;
  var found = [];

  await guard(root, root);

  for (var name of segments) {
    // Listing order, which is what caseSensitivePath.pick chooses by
    var names = await attempt(fs.readdir(current));
    var match = caseSensitivePath.pick(names, name);

    if (match === undefined) throw new NotFoundError("No path matches: " + relPath);

    current = join(current, match);
    await guard(root, current);
    found.push(match);
  }

  return "/" + found.join("/");
}

// Deletes the blog's folder, and a link at its place without following it
async function removeAll(blogID) {
  var { root } = locate(blogID, "/");

  await fs.remove(root);
}

module.exports = {
  read,
  createReadStream,
  serve,
  write,
  writeFrom,
  path,
  commit,
  ensureLocal,
  mkdir,
  rmdir,
  remove,
  move,
  stat,
  exists,
  list,
  listNames,
  listAll,
  walk,
  resolveCaseInsensitive,
  removeAll,
};
