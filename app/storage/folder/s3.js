var config = require("config");
var ensure = require("helper/ensure");
var pathNormalizer = require("helper/pathNormalizer");
var hashFile = require("helper/hashFile");
var sha1File = require("util").promisify(require("helper/transformer/hash"));
var fs = require("fs-extra");
var crypto = require("crypto");
var { randomUUID: uuid } = require("crypto");
var { pipeline } = require("stream/promises");
var { PassThrough, Readable } = require("stream");
var { join, dirname, posix } = require("path");
var s3 = require("../s3");
var sendObject = require("../sendObject");
var contentTypeFor = require("../contentType");
var { walkLocal, createPool, FOLDER_STAGING_DIRECTORY } = require("../util");
var File = require("models/file");
var contentCache = require("./cache");
var { NotFoundError } = require("./errors");

// The S3 backend of storage/folder: a blog's folder is the objects under
// {blogID}/folder/ in the storage bucket, public-read like the rest of
// {blogID}/ (the bucket policy does that, not the objects), and its metadata
// is models/file in Redis. Built and tested against the same specs as
// ./local.js, but nothing selects it yet (#2258 Phase C).
//
// - Metadata reads (stat, exists, list, listNames, listAll, walk,
//   resolveCaseInsensitive) come from models/file, never from ListObjectsV2.
//   Reads of bytes go through the content cache (./cache.js) on the host's
//   instance store: ensureLocal for any size, and read, createReadStream and
//   serve for files up to config.folder_cache.max_file_bytes. Bigger files
//   are streamed straight from the object.
// - Every write goes to S3 first and to the index after it succeeds, and
//   every remove deletes from S3 first and from the index after, so a crash
//   in between leaves the index behind S3, never ahead of it. The SHA-1 is
//   computed while the bytes stream to S3.
// - S3 has no directories. An explicitly made directory is a zero-byte
//   marker object {blogID}/folder/{dir}/; a directory with something in it
//   needs none. When a remove empties a directory, it gets a marker, so the
//   directory survives in S3 as it would on disk and a rebuild of the index
//   from a listing keeps it.
// - Paths are normalised as on the local backend (helper/pathNormalizer, NFC,
//   ".." clamped inside the folder). There are no links on S3, so nothing
//   here can raise ELOOP.
//
// Like the local backend, this relies on one writer per blog at a time (the
// sync lock): the checks before a write and the index update after it are
// not atomic with the S3 call.

function noop() {}

var DEFAULT_LIMIT = 1000;

// Under config.tmp_directory: a file a tool is writing for path() and
// commit(), and a stream being written to disk before its upload. Both are
// short-lived and left to the tmp pruner if a process dies.
var STAGING_DIRECTORY = FOLDER_STAGING_DIRECTORY;
var SPOOL_DIRECTORY = "storage-folder-spool";

// Objects copied at once when a directory moves
var COPY_CONCURRENCY = 8;

var MARKER_TYPE = "application/x-directory";

function failure(code, message) {
  var err = new Error(message);
  err.code = code;
  return err;
}

function checkBlogID(blogID) {
  ensure(blogID, "string");

  if (!blogID) throw new Error("storage/folder: blogID must be a non-empty string");

  if (blogID === "." || blogID === ".." || /[\/\\\0]/.test(blogID)) {
    throw new Error("storage/folder: invalid blogID: " + blogID);
  }
}

// A blog path as "/a/b" ("/" for the folder itself): normalised as the local
// backend does, with ".." unable to climb out of the folder
function locate(blogID, relPath) {
  checkBlogID(blogID);

  relPath = relPath || "/";

  ensure(relPath, "string");

  if (relPath.indexOf("\0") !== -1) throw new Error("storage/folder: path contains a null byte");

  return posix.resolve("/", pathNormalizer(relPath) || "/");
}

function parentOf(path) {
  var i = path.lastIndexOf("/");
  return i <= 0 ? "/" : path.slice(0, i);
}

function ancestorsOf(path) {
  var parts = path.split("/").slice(1, -1);
  var result = [];

  for (var i = 1; i <= parts.length; i++) result.push("/" + parts.slice(0, i).join("/"));

  return result;
}

function root(blogID) {
  return blogID + "/folder/";
}

// The object of a file, or of nothing for a directory
function objectKey(blogID, path) {
  return root(blogID) + path.slice(1);
}

// Everything below a directory, its marker included
function prefixOf(blogID, path) {
  return path === "/" ? root(blogID) : objectKey(blogID, path) + "/";
}

function isRangeError(err) {
  return !!(
    err &&
    (err.name === "InvalidRange" || (err.$metadata && err.$metadata.httpStatusCode === 416))
  );
}

// Runs an S3 call, turning "no such object" into a NotFoundError
async function fromS3(fn) {
  try {
    return await fn();
  } catch (err) {
    if (s3.isNotFound(err)) throw new NotFoundError(err.message);
    throw err;
  }
}

// Directory entries sort by plain code-unit order, as on the local backend,
// so a cursor is just the last name of the previous page
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

// Refuses a write where the disk would: below a file (ENOTDIR) or over a
// directory (EISDIR). Checked before the upload, so S3 never holds an object
// the index could not record.
async function checkWritable(blogID, path, kind) {
  var paths = ancestorsOf(path).concat(path);
  var records = await Promise.all(
    paths.map(function (p) {
      return File.get(blogID, p);
    })
  );

  records.slice(0, -1).forEach(function (record, i) {
    if (record && record.type !== "dir") throw failure("ENOTDIR", "Not a directory: " + paths[i]);
  });

  var own = records[records.length - 1];

  if (own && own.type === "dir" && kind === "file") throw failure("EISDIR", "Is a directory: " + path);
  if (own && own.type !== "dir" && kind === "dir") throw failure("EEXIST", "File exists: " + path);

  return own;
}

async function writeMarker(blogID, path) {
  await s3.putBuffer(prefixOf(blogID, path), Buffer.alloc(0), { contentType: MARKER_TYPE });
}

// When a remove or a move has emptied a directory, it gets a marker so it
// is still there in S3, as it is in the index and would be on disk
async function keepParent(blogID, path) {
  var parent = parentOf(path);

  if (parent === "/") return;

  var page = await File.list(blogID, parent, { limit: 1 });

  if (page && !page.entries.length && !page.cursor) await writeMarker(blogID, parent);
}

async function record(blogID, path, uploaded, modified) {
  await File.set(blogID, path, {
    type: "file",
    size: uploaded.size,
    modified: modified,
    sha1: uploaded.sha1,
  });
}

async function slurp(stream) {
  var chunks = [];
  for await (var chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

// The content cache's description of a file: its key is the blog, the path
// and the SHA-1, or the size and modified time where the index has no hash
function cached(blogID, path, found) {
  return {
    blogID: blogID,
    path: path,
    version: found.sha1 || found.size + "-" + found.modified,
    size: found.size,
    sha1: found.sha1,
  };
}

// Opens the object for the content cache to download
function opener(blogID, path) {
  return function () {
    return fromS3(async function () {
      return (await s3.get(objectKey(blogID, path))).Body;
    });
  };
}

// The index record of a file small enough to read through the cache, or
// null for one to read straight from S3. Rejects if there is no such file.
async function smallFile(blogID, path, relPath) {
  var found = path === "/" ? null : await File.get(blogID, path);

  if (!found || found.type === "dir") throw new NotFoundError("Not a file: " + relPath);

  return found.size <= config.folder_cache.max_file_bytes ? found : null;
}

// Errors from the cache's own disk, which mean the cache can't hold the file
// right now, not that the file is unreadable
var CACHE_DISK_ERRORS = new Set(["ENOSPC", "EDQUOT", "EROFS", "EIO", "EACCES", "EPERM"]);

// Runs fn with the cached copy of a small file. S3 holding bytes the index
// doesn't describe (ECHANGED: the index is behind a write), or the cache's
// disk failing (full, say), resolves to undefined, so the caller reads S3
// directly instead. An error from fn itself is passed on: by then a response
// may have started.
async function throughCache(blogID, path, found, fn) {
  var failedInside = false;

  try {
    return await contentCache().use(cached(blogID, path, found), opener(blogID, path), async function (local) {
      try {
        return await fn(local);
      } catch (err) {
        failedInside = true;
        throw err;
      }
    });
  } catch (err) {
    if (!failedInside && (err.code === "ECHANGED" || CACHE_DISK_ERRORS.has(err.code))) return undefined;
    throw err;
  }
}

async function read(blogID, relPath) {
  var path = locate(blogID, relPath);
  var found = await smallFile(blogID, path, relPath);
  var data = found && (await throughCache(blogID, path, found, (local) => fs.readFile(local)));

  if (data) return data;

  return fromS3(async function () {
    return slurp((await s3.get(objectKey(blogID, path))).Body);
  });
}

// The stream is returned at once and the object opened when it starts, so
// any failure is emitted as its "error" event, as on the local backend
function createReadStream(blogID, relPath, options) {
  var path = locate(blogID, relPath);
  var stream = new PassThrough();
  var source;
  var start = options && options.start;
  var end = options && options.end;
  var range;

  if (start !== undefined || end !== undefined) {
    start = start === undefined ? 0 : start;

    if (!Number.isInteger(start) || start < 0 || (end !== undefined && (!Number.isInteger(end) || end < start))) {
      // fs.createReadStream throws this straight away; here it is the
      // stream's error, like every other failure
      var err = new RangeError("storage/folder: invalid range " + start + "-" + end);
      err.code = "ERR_OUT_OF_RANGE";
      process.nextTick(function () {
        stream.destroy(err);
      });
      return stream;
    }

    range = "bytes=" + start + "-" + (end === undefined ? "" : end);
  }

  // A small file is read from its cached copy, held until the copy is open:
  // after that the open file outlives an eviction
  function fromCache(found) {
    return throughCache(blogID, path, found, function (local) {
      return new Promise(function (resolve, reject) {
        var file = fs.createReadStream(local, { start: start, end: end });

        file.on("open", function () {
          resolve(file);
        });
        file.on("error", reject);
      });
    });
  }

  smallFile(blogID, path, relPath)
    .then(async function (found) {
      var file = found && (await fromCache(found));

      if (file) return file;

      return (await s3.get(objectKey(blogID, path), { range: range })).Body;
    })
    .then(function (body) {
      if (stream.destroyed) return body.destroy();

      source = body;
      source.on("error", function (err) {
        stream.destroy(err);
      });
      source.pipe(stream);
    })
    .catch(function (err) {
      // A range starting past the end is empty on disk, an error on S3
      if (isRangeError(err)) return stream.end();
      if (s3.isNotFound(err)) err = new NotFoundError(err.message);
      stream.destroy(err);
    });

  stream.on("close", function () {
    if (source) source.destroy();
  });

  return stream;
}

async function serve(req, res, blogID, relPath, options) {
  options = options || {};

  var path = locate(blogID, relPath);

  // A trailing slash is the directory's index.html, as it is for sendFile
  if (!relPath || relPath.slice(-1) === "/") path = posix.join(path, "index.html");

  if (
    options.dotfiles === "ignore" &&
    path.split("/").some(function (segment) {
      return segment.charAt(0) === ".";
    })
  ) {
    throw new NotFoundError();
  }

  var found = await smallFile(blogID, path, relPath);
  var sent = found && (await throughCache(blogID, path, found, (local) => sendCached(res, local, found, options, objectKey(blogID, path))));

  if (sent) return;

  return sendObject(req, res, objectKey(blogID, path), options, {
    notFound: function (err) {
      return new NotFoundError(err && err.message);
    },
    label: "[storage/folder] s3 stream failed blog=" + blogID + " path=" + path,
  });
}

// Sends a cached copy with res.sendFile, which handles Range and the
// conditional headers. The validators come from the index, not the copy's
// own times (the cache uses those for recency), so they are the same on every
// host and after every eviction. Resolves to true once sent.
function sendCached(res, local, found, options, key) {
  // The type an upload gives the object (extensionless paths are text/html),
  // so a cached copy is served as the S3 one would be. options.headers can
  // still override it.
  res.setHeader("Content-Type", contentTypeFor(key));
  res.setHeader("ETag", found.sha1 ? '"' + found.sha1 + '"' : 'W/"' + found.size + "-" + found.modified + '"');
  res.setHeader("Last-Modified", new Date(found.modified).toUTCString());

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
        if (!err) return resolve(true);
        if (err.status === 404 || err.code === "ENOENT") return reject(new NotFoundError(err.message));
        reject(err);
      }
    );
  });
}

async function write(blogID, relPath, data) {
  // The stream can fail during the awaits below, before pipeline listens for
  // it, and an "error" with no listener would take down the process
  if (data instanceof Readable) data.on("error", noop);

  var path = locate(blogID, relPath);

  if (path === "/") throw new Error("storage/folder: write needs a path inside the folder");

  await checkWritable(blogID, path, "file");

  var uploaded;

  if (data instanceof Readable) {
    if (data.errored) throw data.errored;

    // An upload of unknown length needs multipart, which is more requests
    // and more to go wrong for the small files most writes are. Spooling to
    // disk first gives a length, and a stream which fails part way never
    // reaches S3, so the object already there is kept.
    var spool = join(config.tmp_directory, SPOOL_DIRECTORY, uuid());

    try {
      await fs.ensureDir(dirname(spool));
      await pipeline(data, fs.createWriteStream(spool));
      uploaded = await s3.uploadFile(objectKey(blogID, path), spool);
    } finally {
      await fs.remove(spool).catch(noop);
    }
  } else {
    uploaded = await s3.putBuffer(objectKey(blogID, path), Buffer.isBuffer(data) ? data : Buffer.from(data));
  }

  await record(blogID, path, uploaded, Date.now());
}

// A copy is modified now, as fs.copyFile makes it on disk. A move keeps the
// source's modified time, as a rename does. options.modified (ms) overrides
// both, for the mirror of a file already on disk (./mirror.js).
async function writeFrom(blogID, relPath, srcPath, options) {
  var move = !!(options && options.move);
  var given = options && options.modified;
  var path = locate(blogID, relPath);

  if (path === "/") throw new Error("storage/folder: write needs a path inside the folder");

  await checkWritable(blogID, path, "file");

  try {
    var modified = given !== undefined ? given : move ? (await fs.stat(srcPath)).mtimeMs : Date.now();
    var uploaded = await s3.uploadFile(objectKey(blogID, path), srcPath);
  } catch (err) {
    if (err.code === "ENOENT") throw new NotFoundError(err.message);
    throw err;
  }

  await record(blogID, path, uploaded, modified);

  if (move) await fs.remove(srcPath);
}

// A staging place for a tool which writes to a path itself. commit uploads
// whatever is there and deletes it.
async function path(blogID, relPath) {
  var p = locate(blogID, relPath);

  return join(config.tmp_directory, STAGING_DIRECTORY, blogID, ...p.split("/").filter(Boolean));
}

// Uploads the file a tool wrote to path(blogID, relPath), or every file
// below it for a directory. Nothing there is not an error, as on disk.
async function commit(blogID, relPath) {
  var p = locate(blogID, relPath);
  var staged = await path(blogID, p);
  var stat;

  try {
    stat = await fs.stat(staged);
  } catch (err) {
    if (err.code === "ENOENT" || err.code === "ENOTDIR") return;
    throw err;
  }

  var files = [];

  if (stat.isDirectory()) {
    for await (var file of walkLocal(staged)) files.push(posix.join(p, file));
  } else {
    files.push(p);
  }

  for (var target of files) {
    var local = await path(blogID, target);

    await writeFrom(blogID, target, local);
    await fs.remove(local).catch(noop);
  }
}

// The path of a copy of the file in the content cache. The copy is
// read-only, and may be evicted once it is no longer recent, so use it
// straight away: open it, or hand it to a tool, rather than keeping the path.
async function ensureLocal(blogID, relPath) {
  var path = locate(blogID, relPath);

  // A second try picks up the index catching up with a write in progress
  for (var attempt = 0; ; attempt++) {
    var found = await File.get(blogID, path);

    if (!found) throw new NotFoundError("No such file: " + relPath);
    if (found.type === "dir") throw failure("EISDIR", "Is a directory: " + relPath);

    try {
      return await contentCache().get(cached(blogID, path, found), opener(blogID, path));
    } catch (err) {
      if (err.code !== "ECHANGED" || attempt) throw err;
    }
  }
}

async function mkdir(blogID, relPath) {
  var path = locate(blogID, relPath);

  // The folder itself always exists
  if (path === "/") return;

  var found = await checkWritable(blogID, path, "dir");

  if (found) return;

  await writeMarker(blogID, path);
  await File.set(blogID, path, { type: "dir", modified: Date.now() });
}

// Deletes from S3 everything at and below path, whatever the index says, so
// nothing it missed is left behind, then forgets it in the index
async function removePath(blogID, path, found) {
  if (found && found.type === "file") await s3.deleteKeys([objectKey(blogID, path)]);
  else await s3.remove(objectKey(blogID, path));

  await File.remove(blogID, path);
}

async function removeOne(blogID, relPath, onlyDirectory) {
  var path = locate(blogID, relPath);

  // Emptying the folder is not a remove: removeAll deletes the blog
  if (path === "/") throw new Error("storage/folder: remove needs a path inside the folder");

  var found = await File.get(blogID, path);

  if (onlyDirectory && found && found.type !== "dir") {
    throw failure("ENOTDIR", "Not a directory: " + relPath);
  }

  await removePath(blogID, path, found);
  await keepParent(blogID, path);
}

function rmdir(blogID, relPath) {
  return removeOne(blogID, relPath, true);
}

function remove(blogID, relPath) {
  return removeOne(blogID, relPath, false);
}

// The index records of everything below a directory, a batch at a time
async function* recordsBelow(blogID, dir) {
  var batch = [];

  async function flush() {
    var records = await Promise.all(
      batch.map(function (p) {
        return File.get(blogID, p);
      })
    );

    return batch.map(function (p, i) {
      return { path: p, record: records[i] };
    });
  }

  for await (var p of File.subtree(blogID, dir)) {
    batch.push(p);

    if (batch.length >= 500) {
      yield await flush();
      batch = [];
    }
  }

  if (batch.length) yield await flush();
}

// Copy, then delete: S3 cannot rename, and a directory is many objects. The
// destination's records keep the source's sizes, times and hashes, as a
// rename keeps them on disk.
async function move(blogID, from, to) {
  var source = locate(blogID, from);
  var destination = locate(blogID, to);

  if (source === "/" || destination === "/") {
    throw new Error("storage/folder: move needs paths inside the folder");
  }

  var found = await File.get(blogID, source);

  if (!found) throw new NotFoundError("No such file or directory: " + from);

  if (source === destination) return;

  if (destination.indexOf(source + "/") === 0) {
    throw failure("EINVAL", "Cannot move " + from + " into itself");
  }

  // Replacing the destination would delete the source along with it
  if (source.indexOf(destination + "/") === 0) {
    throw failure("EINVAL", "Cannot move " + from + " over its own ancestor " + to);
  }

  // Whatever is at the destination is replaced, but not anything above it
  var replaced = await File.get(blogID, destination);

  await checkWritable(blogID, destination, replaced ? replaced.type : found.type);

  if (replaced) await removePath(blogID, destination, replaced);

  if (found.type === "file") {
    await s3.copy(objectKey(blogID, source), objectKey(blogID, destination), {
      contentType: contentTypeFor(objectKey(blogID, destination)),
    });
    await File.set(blogID, destination, found);
    await s3.deleteKeys([objectKey(blogID, source)]);
    await File.remove(blogID, source);
    await keepParent(blogID, source);
    return;
  }

  var from_ = prefixOf(blogID, source);
  var to_ = prefixOf(blogID, destination);
  var pool = createPool(COPY_CONCURRENCY);
  var copied = 0;

  try {
    for await (var entry of s3.listEntries(from_)) {
      var target = to_ + entry.key.slice(from_.length);
      copied++;
      // A file's type follows its new name; a marker stays a marker
      await pool.add(
        s3.copy.bind(null, entry.key, target, target.slice(-1) === "/" ? {} : { contentType: contentTypeFor(target) })
      );
    }

    await pool.drain();
  } catch (err) {
    await pool.drain().catch(noop);
    throw err;
  }

  // A directory only the index knew about, with no objects and no marker
  if (!copied) await writeMarker(blogID, destination);

  await File.set(blogID, destination, found);

  for await (var batch of recordsBelow(blogID, source)) {
    await File.setMany(
      blogID,
      batch
        .filter(function (item) {
          return item.record;
        })
        .map(function (item) {
          return Object.assign({}, item.record, { path: destination + item.path.slice(source.length) });
        })
    );
  }

  await s3.removePrefix(from_);
  await File.remove(blogID, source);
  await keepParent(blogID, source);
}

async function stat(blogID, relPath, options) {
  var path = locate(blogID, relPath);
  var found = await File.get(blogID, path);

  if (!found) throw new NotFoundError("No such file or directory: " + relPath);

  var isDirectory = found.type === "dir";
  var result = {
    isDirectory: isDirectory,
    size: isDirectory ? 0 : found.size,
    modified: found.modified,
  };

  // Dropbox's content_hash is not in the index (its SHA-1 is), so this costs
  // a download until the Dropbox client keeps its own { sha1, content_hash }
  // pairs (#2258, "Content hash")
  if (options && options.hash && !isDirectory) {
    result.hash = await hashFile(await ensureLocal(blogID, path));
  }

  // Free from the index, unless a rebuild without hashing left it out
  if (options && options.sha1 && !isDirectory) {
    result.sha1 = found.sha1 || (await sha1File(await ensureLocal(blogID, path)));
  }

  return result;
}

async function exists(blogID, relPath) {
  try {
    await stat(blogID, relPath);
    return true;
  } catch (err) {
    if (err instanceof NotFoundError) return false;
    throw err;
  }
}

// A directory's entries, sorted by name, or NotFoundError
async function entriesOf(blogID, path, relDir) {
  var entries = await File.listAll(blogID, path);

  if (!entries) throw new NotFoundError("No such directory: " + relDir);

  return entries;
}

// The directory's hash is read whole and sorted, as the local backend reads
// a directory whole, since HSCAN has no order to page by
async function list(blogID, relDir, options) {
  options = options || {};

  var limit = options.limit === undefined ? DEFAULT_LIMIT : options.limit;

  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("storage/folder: limit must be a positive integer");
  }

  var after = options.cursor ? decodeCursor(options.cursor) : null;
  var path = locate(blogID, relDir);
  var entries = (await entriesOf(blogID, path, relDir)).filter(function (entry) {
    return after === null || entry.name > after;
  });
  var page = entries.slice(0, limit);

  return {
    entries: page.map(function (entry) {
      var isDirectory = entry.type === "dir";

      return {
        name: entry.name,
        isDirectory: isDirectory,
        size: isDirectory ? 0 : entry.size,
        modified: entry.modified,
      };
    }),
    cursor: entries.length > limit ? encodeCursor(page[page.length - 1].name) : null,
  };
}

async function listNames(blogID, relDir) {
  var path = locate(blogID, relDir);

  return (await entriesOf(blogID, path, relDir)).map(function (entry) {
    return { name: entry.name, isDirectory: entry.type === "dir" };
  });
}

async function listAll(blogID, relDir) {
  var page = await list(blogID, relDir, { limit: Number.MAX_SAFE_INTEGER });

  return page.entries;
}

// Depth first and sorted by name, a directory at a time, as on the local
// backend. A directory which vanishes mid-walk is skipped; the one asked for
// must exist.
async function* walk(blogID, relDir, options) {
  var path = locate(blogID, relDir);
  var directories = !!(options && options.directories);

  async function* visit(current, top) {
    var entries = await File.listAll(blogID, current);

    if (!entries) {
      if (top) throw new NotFoundError("No such directory: " + relDir);
      return;
    }

    for (var entry of entries) {
      var full = current === "/" ? "/" + entry.name : current + "/" + entry.name;

      if (entry.type === "dir") {
        if (directories) yield full;
        yield* visit(full, false);
      } else {
        yield full;
      }
    }
  }

  yield* visit(path, true);
}

async function resolveCaseInsensitive(blogID, relPath) {
  var path = locate(blogID, relPath);
  var found = await File.resolveCaseInsensitive(blogID, path);

  if (found === null) throw new NotFoundError("No path matches: " + relPath);

  return found;
}

// Deletes the blog's whole folder from S3, then its index, its cached
// copies and anything it left in the tmp directory
async function removeAll(blogID) {
  checkBlogID(blogID);

  await s3.removePrefix(root(blogID));
  await File.removeAll(blogID);
  await contentCache().removeBlog(blogID).catch(noop);
  await fs.remove(join(config.tmp_directory, STAGING_DIRECTORY, blogID)).catch(noop);
}

async function sha1Of(key) {
  var hash = crypto.createHash("sha1");
  var data = await s3.get(key);

  for await (var chunk of data.Body) hash.update(chunk);

  return hash.digest("hex");
}

// Index records for everything in a blog's folder in S3, from a full
// listing, for rebuilding models/file. A file's modified time is when its
// object was written, so a time a move kept is lost. With { hash: true }
// every file is downloaded to compute its SHA-1; without it, the records
// have none.
async function* indexRecords(blogID, options) {
  checkBlogID(blogID);

  var prefix = root(blogID);
  var hash = !!(options && options.hash);

  for await (var entry of s3.listEntries(prefix)) {
    var rel = entry.key.slice(prefix.length);
    var modified = entry.modified ? new Date(entry.modified).getTime() : 0;

    // The folder's own marker, if anything made one
    if (!rel || rel === "/") continue;

    if (rel.slice(-1) === "/") {
      yield { path: "/" + rel.slice(0, -1), type: "dir", size: 0, modified: modified };
    } else {
      yield {
        path: "/" + rel,
        type: "file",
        size: entry.size,
        modified: modified,
        sha1: hash ? await sha1Of(entry.key) : "",
      };
    }
  }
}

// Replaces a blog's models/file index with one built from S3
function rebuildIndex(blogID, options) {
  return File.rebuild(blogID, indexRecords(blogID, options));
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
  indexRecords,
  rebuildIndex,
};
