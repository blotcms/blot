var config = require("config");
var { blog_static_files_dir } = config;
var ensure = require("helper/ensure");
var clfdate = require("helper/clfdate");
var fs = require("fs-extra");
var crypto = require("crypto");
var { pipeline } = require("stream/promises");
var { Readable } = require("stream");
var { join, dirname, resolve, relative, sep } = require("path");
var s3 = require("./s3");
var { isMissing, walkLocal, createPool } = require("./util");

// Every per-blog generated asset (thumbnails, image cache, converter output,
// avatars, template uploads, ...) lives under blog_static_files_dir/{blogID}.
// This module is the single choke point for reading, writing, deleting,
// listing and serving those files.
//
// When config.assets.bucket is set, every write is also uploaded to the
// bucket (key: {blogID}/{relPath}) and every delete removes the object too.
// Reads try config.assets.read first ("disk", the default, or "s3") and fall
// back to the other source when the file isn't there. With no bucket set
// nothing here touches S3. See README.
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

function notFound(blogID, relPath, err) {
  var error = new NotFoundError(
    "storage/assets: not found: " + blogID + "/" + strip(relPath)
  );
  if (err) error.cause = err;
  return error;
}

// Fraction of disk-first reads which find the file only in S3 that are logged
const FALLBACK_LOG_RATE = 0.01;

// How many files of a directory are uploaded at once
const COMMIT_CONCURRENCY = 8;

function useS3() {
  return s3.enabled();
}

function s3First() {
  return useS3() && config.assets.read === "s3";
}

// relPath normalised to the form used in keys: relative to the blog's asset
// directory, "/"-separated, with no leading slash, and "" for the directory
// itself. Throws if relPath escapes the directory.
function normalise(blogID, relPath) {
  return relative(root(blogID), path(blogID, relPath)).split(sep).join("/");
}

function keyFor(blogID, relPath) {
  return s3.key(blogID, normalise(blogID, relPath));
}

// Runs an S3 call, turning "no such object" into a NotFoundError
async function fromS3(blogID, relPath, fn) {
  try {
    return await fn();
  } catch (err) {
    if (s3.isNotFound(err)) throw notFound(blogID, relPath, err);
    throw err;
  }
}

// What to do when S3 refuses an upload. While disk is still the source of
// truth the file is safe locally, so it's logged (grep for
// "[storage/assets] s3") and the operation succeeds; once reads come from S3
// a missing object is a real problem so the error goes to the caller.
function s3Failed(action, blogID, relPath, err) {
  if (s3First()) throw err;

  console.log(
    clfdate(),
    "[storage/assets] s3 " + action + " failed",
    "blog=" + blogID,
    "path=" + strip(relPath),
    (err && err.name) + ":",
    err && err.message
  );
}

// Calls the source functions in read order until one has the file. Each
// throws NotFoundError when it doesn't; any other error is final. Without a
// bucket only fromDisk is called.
async function fromSources(blogID, relPath, op, fromDisk, fromBucket) {
  if (!useS3()) return fromDisk();

  var order = s3First()
    ? [fromBucket, fromDisk]
    : [fromDisk, fromBucket];

  for (var i = 0; i < order.length; i++) {
    try {
      var result = await order[i]();

      if (i === 1 && order[i] === fromBucket && Math.random() < FALLBACK_LOG_RATE) {
        console.log(
          clfdate(),
          "[storage/assets] " + op + " not on disk, read from s3",
          "blog=" + blogID,
          "path=" + strip(relPath)
        );
      }

      return result;
    } catch (err) {
      if (!(err instanceof NotFoundError)) throw err;
    }
  }

  throw notFound(blogID, relPath);
}

// The public CDN URL of an asset. Names are used as given; callers which
// URL-encode their filenames encode them before passing them in.
function url(blogID, relPath) {
  path(blogID, relPath);
  return config.cdn.origin + "/" + blogID + "/" + strip(relPath);
}

// Uploads one local file, applying the failure policy
async function uploadFile(blogID, relPath, localFile) {
  try {
    await s3.upload(blogID, relPath, localFile);
  } catch (err) {
    s3Failed("upload", blogID, relPath, err);
  }
}

// Called after a file (or directory tree) has been written to
// path(blogID, relPath) by a tool that needed a local path. The file is
// already where it belongs on disk; with a bucket configured it's uploaded
// too (every file, for a directory). Nothing existing at relPath (e.g. a
// converter whose document had no media) is not an error.
async function commit(blogID, relPath) {
  var local = path(blogID, relPath);

  if (!useS3()) return;

  var stat;

  try {
    stat = await fs.stat(local);
  } catch (err) {
    if (isMissing(err)) return;
    throw err;
  }

  var rel = normalise(blogID, relPath);

  if (!stat.isDirectory()) return uploadFile(blogID, rel, local);

  var pool = createPool(COMMIT_CONCURRENCY);

  try {
    for await (var file of walkLocal(local)) {
      await pool.add(
        uploadFile.bind(null, blogID, rel ? rel + "/" + file : file, join(local, file))
      );
    }
  } catch (err) {
    // add() rejects as soon as an earlier upload has failed. Wait for the
    // uploads still running to settle before failing, so none are left in
    // flight once the caller has been told; the first error is the one thrown.
    await pool.drain().catch(function () {});
    throw err;
  }

  await pool.drain();
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
  return fromSources(
    blogID,
    relPath,
    "read",
    async function () {
      try {
        return await fs.readFile(path(blogID, relPath));
      } catch (err) {
        if (isMissing(err)) throw notFound(blogID, relPath, err);
        throw err;
      }
    },
    function () {
      return fromS3(blogID, relPath, async function () {
        var data = await s3.get(keyFor(blogID, relPath));
        return Buffer.from(await data.Body.transformToByteArray());
      });
    }
  );
}

async function exists(blogID, relPath) {
  try {
    return await fromSources(
      blogID,
      relPath,
      "exists",
      async function () {
        if (await fs.pathExists(path(blogID, relPath))) return true;
        throw notFound(blogID, relPath);
      },
      async function () {
        if (await s3.head(keyFor(blogID, relPath))) return true;
        throw notFound(blogID, relPath);
      }
    );
  } catch (err) {
    if (err instanceof NotFoundError) return false;
    throw err;
  }
}

// Names of the immediate children of a directory, or [] if it doesn't exist.
// With a bucket, the children found on disk and in S3 together.
async function list(blogID, relDir) {
  var names;

  try {
    names = await fs.readdir(path(blogID, relDir || ""));
  } catch (err) {
    if (!isMissing(err)) throw err;
    names = [];
  }

  if (!useS3()) return names;

  var rel = normalise(blogID, relDir || "");
  var prefix = blogID + "/" + (rel ? rel + "/" : "");
  var found = new Set(names);

  for await (var entry of s3.listEntries(prefix, "/")) {
    var name = (entry.key || entry.prefix).slice(prefix.length).replace(/\/$/, "");

    // a "folder" placeholder object is the prefix itself
    if (name) found.add(name);
  }

  return Array.from(found).sort();
}

// Every file in a blog's asset scope, as relPaths with no leading slash. With
// a bucket, files on disk and then those only in S3.
async function* walk(blogID) {
  var seen = useS3() ? new Set() : null;

  for await (var file of walkLocal(root(blogID))) {
    if (seen) seen.add(file);
    yield file;
  }

  if (!seen) return;

  var prefix = blogID + "/";

  for await (var entry of s3.listEntries(prefix)) {
    var rel = entry.key.slice(prefix.length);

    if (rel && !/\/$/.test(rel) && !seen.has(rel)) yield rel;
  }
}

// A stream of the file's bytes, which errors with NotFoundError if there's no
// such file. With a bucket the file is opened (disk or S3, in read order)
// only when the stream is first read, so a caller can queue many streams
// without holding connections open.
function createReadStream(blogID, relPath) {
  var local = path(blogID, relPath);

  if (!useS3()) return fs.createReadStream(local);

  var source;
  var started = false;
  var stream = new Readable({
    read: function () {
      if (!started) {
        started = true;
        open().then(attach, function (err) {
          stream.destroy(err);
        });
      } else if (source) {
        source.resume();
      }
    },
    destroy: function (err, callback) {
      if (source) source.destroy();
      callback(err);
    },
  });

  function attach(body) {
    if (stream.destroyed) return body.destroy();

    source = body;
    body.on("data", function (chunk) {
      if (!stream.push(chunk)) body.pause();
    });
    body.on("end", function () {
      stream.push(null);
    });
    body.on("error", function (err) {
      stream.destroy(err);
    });
  }

  function open() {
    return fromSources(
      blogID,
      relPath,
      "createReadStream",
      async function () {
        try {
          await fs.stat(local);
        } catch (err) {
          if (isMissing(err)) throw notFound(blogID, relPath, err);
          throw err;
        }

        return fs.createReadStream(local);
      },
      function () {
        return fromS3(blogID, relPath, async function () {
          return (await s3.get(keyFor(blogID, relPath))).Body;
        });
      }
    );
  }

  return stream;
}

var downloads = new Map();

// Downloads an object into the cache under the app's tmp directory and
// resolves to its path. A cached copy is reused while it is at least as new
// as the object. The file appears in the cache only once complete, so
// concurrent callers never see part of it.
async function download(blogID, relPath) {
  var rel = normalise(blogID, relPath);
  var objectKey = s3.key(blogID, rel);
  var destination = join(config.tmp_directory, "storage-assets", blogID, rel);

  var info = await s3.head(objectKey);

  if (!info) throw notFound(blogID, relPath);

  try {
    var cached = await fs.stat(destination);

    if (cached.size === info.size && cached.mtimeMs >= (info.modified ? info.modified.getTime() : 0)) {
      return destination;
    }
  } catch (err) {
    if (!isMissing(err)) throw err;
  }

  if (downloads.has(destination)) return downloads.get(destination);

  var attempt = (async function () {
    // The tmp directory is pruned, which can remove the directory between
    // creating it and writing into it
    for (var tries = 1; ; tries++) {
      var temporary =
        destination + "." + crypto.randomBytes(6).toString("hex") + ".download";

      try {
        await fs.ensureDir(dirname(destination));
        var data = await s3.get(objectKey);
        await pipeline(data.Body, fs.createWriteStream(temporary));
        await fs.rename(temporary, destination);
        return destination;
      } catch (err) {
        await fs.remove(temporary).catch(function () {});

        if (s3.isNotFound(err)) throw notFound(blogID, relPath, err);
        if (err.code === "ENOENT" && tries < 3) continue;
        throw err;
      }
    }
  })();

  downloads.set(destination, attempt);

  try {
    return await attempt;
  } finally {
    downloads.delete(destination);
  }
}

// Resolves to an absolute local path which holds the file, for callers which
// need a real file (hashing, sharp input). The caller must not modify or
// delete it. A file which is only in S3 is downloaded to a cache in the tmp
// directory (never into the static files directory).
async function ensureLocal(blogID, relPath) {
  var local = path(blogID, relPath);

  return fromSources(
    blogID,
    relPath,
    "ensureLocal",
    async function () {
      try {
        await fs.stat(local);
      } catch (err) {
        if (isMissing(err)) throw notFound(blogID, relPath, err);
        throw err;
      }

      return local;
    },
    function () {
      return download(blogID, relPath);
    }
  );
}

// Formats a Cache-Control the way send (and so res.sendFile) does: maxAge is
// milliseconds or a string like "1y", and is capped at a year.
var MAX_MAXAGE = 31536000000;
var UNITS = {
  ms: 1,
  s: 1000,
  m: 60000,
  h: 3600000,
  d: 86400000,
  w: 604800000,
  y: 31557600000,
};

function toMilliseconds(value) {
  if (typeof value === "number") return value;

  var match = /^\s*(-?\d*\.?\d+)\s*(ms|s|m|h|d|w|y)?\s*$/i.exec(String(value));

  if (!match) return 0;

  return parseFloat(match[1]) * UNITS[(match[2] || "ms").toLowerCase()];
}

function cacheControl(options) {
  var maxAge = Math.min(Math.max(0, toMilliseconds(options.maxAge || 0)), MAX_MAXAGE);
  var value = "public, max-age=" + Math.floor(maxAge / 1000);

  if (options.immutable) value += ", immutable";

  return value;
}

function hasHeader(headers, name) {
  return Object.keys(headers || {}).some(function (key) {
    return key.toLowerCase() === name;
  });
}

function serveDisk(req, res, blogID, relPath, options) {
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

// Serves the object like res.sendFile would serve the file: Range,
// If-None-Match and If-Modified-Since are passed to S3, and the status
// (200, 206, 304, 416), validators and caching headers are set from its
// answer.
async function serveS3(req, res, blogID, relPath, options) {
  var rel = normalise(blogID, relPath);

  if (!rel) throw notFound(blogID, relPath);

  if (
    options.dotfiles === "ignore" &&
    rel.split("/").some(function (segment) {
      return segment.charAt(0) === ".";
    })
  ) {
    throw notFound(blogID, relPath);
  }

  var isHead = req.method === "HEAD";
  var object = await fromS3(blogID, relPath, function () {
    return s3.open(s3.key(blogID, rel), {
      head: isHead,
      range: req.headers.range,
      ifNoneMatch: req.headers["if-none-match"],
      ifModifiedSince: req.headers["if-modified-since"],
    });
  });

  res.statusCode = object.status;
  res.setHeader("Accept-Ranges", "bytes");

  if (object.etag) res.setHeader("ETag", object.etag);
  if (object.modified) res.setHeader("Last-Modified", object.modified.toUTCString());

  if (!hasHeader(options.headers, "cache-control")) {
    res.setHeader("Cache-Control", cacheControl(options));
  }

  if (object.status === 304) {
    applyHeaders(res, options.headers);
    return res.end();
  }

  if (object.status === 416) {
    applyHeaders(res, options.headers);
    res.setHeader("Content-Range", "bytes */" + object.size);
    res.setHeader("Content-Length", "0");
    return res.end();
  }

  if (object.contentType) res.setHeader("Content-Type", object.contentType);

  applyHeaders(res, options.headers);

  res.setHeader("Content-Length", object.contentLength);

  if (object.contentRange) res.setHeader("Content-Range", object.contentRange);

  if (isHead) return res.end();

  try {
    await pipeline(object.body, res);
  } catch (err) {
    // The client went away, or S3 dropped the connection part way through.
    // Headers are already sent, so there's nothing left to tell the caller.
    object.body.destroy();
    res.destroy();

    if (err.code !== "ERR_STREAM_PREMATURE_CLOSE") {
      console.log(
        clfdate(),
        "[storage/assets] s3 stream failed",
        "blog=" + blogID,
        "path=" + strip(relPath),
        err.message
      );
    }
  }
}

function applyHeaders(res, headers) {
  Object.keys(headers || {}).forEach(function (name) {
    res.setHeader(name, headers[name]);
  });
}

// Sends an asset as the response. Range requests, ETag, Last-Modified and
// content-type come from res.sendFile (or, for an object only in S3, from
// S3's answer). Rejects with NotFoundError if the asset doesn't exist so
// callers can fall through or send a 404.
//   maxAge     milliseconds or an ms string, e.g. "1y"
//   immutable  adds the immutable Cache-Control directive
//   headers    extra response headers (they win over the defaults)
//   dotfiles   "allow" (default) or "ignore" to treat dotfiles as missing
async function serve(req, res, blogID, relPath, options) {
  options = options || {};

  // Throws if relPath tries to leave the blog's asset directory
  path(blogID, relPath);

  return fromSources(
    blogID,
    relPath,
    "serve",
    function () {
      return serveDisk(req, res, blogID, relPath, options);
    },
    function () {
      return serveS3(req, res, blogID, relPath, options);
    }
  );
}

// Removes a file or a whole directory. A missing path is not an error. The
// bucket copy goes first and a failure there is thrown in either read order:
// unlike a failed upload, a failed delete isn't covered by disk, because a
// read that misses on disk falls back to the bucket and would bring the file
// back (publicly, for blog_* keys). Throwing before the local delete leaves
// both copies in place for the caller to retry.
async function remove(blogID, relPath) {
  var local = path(blogID, relPath);

  // An empty relPath would be a scope-wide delete, which only removeAll does
  if (resolve(local) === resolve(root(blogID))) {
    throw new Error("storage/assets: remove needs a path inside the blog's asset directory");
  }

  if (useS3()) await s3.remove(keyFor(blogID, relPath));

  await fs.remove(local);
}

// Removes a blog's entire asset directory. This is only used by blog
// deletion. Unlike remove(), a bucket failure is never swallowed, whatever the
// read order: the bucket is publicly readable for blog_* keys, so a delete
// which silently failed would leave a deleted blog's assets on the CDN. The
// error goes to the caller (blog deletion), which reports it and can be
// retried. Preserves the realpath safety check that used to live in
// app/models/blog/remove.js's safelyRemove: resolve both realpaths and make
// sure the folder is strictly inside blog_static_files_dir before removing.
async function removeAll(blogID) {
  var folder = root(blogID);
  var realpathToFolder;

  try {
    realpathToFolder = await fs.realpath(folder);
  } catch (err) {
    // This folder does not exist, so there is nothing on disk to remove
    if (err.code !== "ENOENT") throw err;
  }

  if (realpathToFolder) {
    var realpathToRoot = await fs.realpath(blog_static_files_dir);

    if (realpathToFolder.indexOf(realpathToRoot + sep) !== 0) {
      throw new Error("Could not safely remove directory: " + folder);
    }

    await fs.remove(realpathToFolder);
  }

  if (!useS3()) return;

  await s3.removePrefix(blogID + "/");
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
