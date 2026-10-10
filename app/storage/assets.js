var config = require("config");
var ensure = require("helper/ensure");
var clfdate = require("helper/clfdate");
var fs = require("fs-extra");
var crypto = require("crypto");
var { pipeline } = require("stream/promises");
var { Readable } = require("stream");
var { join, dirname, resolve, relative, sep } = require("path");
var s3 = require("./s3");
var { isMissing, walkLocal, createPool, STAGING_DIRECTORY } = require("./util");

// Every per-blog generated asset (thumbnails, image cache, converter output,
// avatars, template uploads, ...) lives in the assets bucket (config.assets),
// keyed {blogID}/{relPath}. This module is the single choke point for
// reading, writing, deleting, listing and serving those objects.
//
// Callers name a file by (blogID, relPath), where relPath is relative to the
// blog's asset directory, e.g. "_thumbnails/{uuid}/small.jpg". A leading "/"
// is allowed (so req.baseUrl + req.path can be passed straight in) and is
// ignored. Every relPath goes through the same escape guard as path().
//
// Tools that insist on writing to a local path themselves (sharp's toFile,
// pandoc --extract-media, puppeteer) write to path(blogID, relPath), which is
// a staging path under the app's tmp directory, and then call
// commit(blogID, relPath) once the file or directory is complete. commit
// uploads it and deletes the staged copy, so nothing is kept locally: read it
// back with read(), createReadStream() or ensureLocal(). Everything else uses
// write() or writeFrom(), which stage and commit the same way. See README.

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

// Where tools stage files before they are committed. It is under the tmp
// directory, so it is on the instance store and is pruned with it (see
// app/scheduler/prune-tmp.js, which gives it a far longer life than a build).
function stagingRoot() {
  return join(config.tmp_directory, STAGING_DIRECTORY);
}

function root(blogID) {
  ensure(blogID, "string");

  if (!blogID) throw new Error("storage/assets: blogID must be a non-empty string");

  var base = stagingRoot();
  var directory = join(base, blogID);

  // A blogID which is a path (or ".."), not a name
  if (dirname(directory) !== base) {
    throw new Error("storage/assets: invalid blogID: " + blogID);
  }

  return directory;
}

// Builds an absolute local staging path for a file in a blog's asset
// directory. With no segments this returns the blog's staging directory
// itself. Throws if the joined path would resolve outside of it (e.g. a
// segment of "../").
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

// Where objects downloaded for ensureLocal are cached, under the tmp directory
const DOWNLOAD_DIRECTORY = "storage-assets";

// How many files of a directory are uploaded at once
const COMMIT_CONCURRENCY = 8;

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

// The public CDN URL of an asset. Names are used as given; callers which
// URL-encode their filenames encode them before passing them in.
function url(blogID, relPath) {
  path(blogID, relPath);
  return config.cdn.origin + "/" + blogID + "/" + strip(relPath);
}

// Uploads one staged file and deletes it. A file which has already gone was
// taken by a commit of a directory which held it too, so there's nothing to do.
async function uploadAndRemove(blogID, file) {
  try {
    await s3.upload(blogID, file.rel, file.local);
  } catch (err) {
    if (err.code === "ENOENT") return;
    throw err;
  }

  // Not deleting it only leaves it for the tmp pruner
  await fs.remove(file.local).catch(function () {});
}

// Removes the directories a commit emptied, best-effort. A blog's top-level
// directories (_thumbnails, _assets, ...) are shared by every build of the
// blog, and a tool may have just created one to write into, so they stay
// (the pruner removes them when they've been empty a while); anything deeper
// is removed only if nothing is in it.
async function removeEmptyDirectories(blogID, rels) {
  var directories = new Set();

  rels.forEach(function (rel) {
    var parts = rel.split("/").slice(0, -1);

    while (parts.length >= 2) {
      directories.add(parts.join("/"));
      parts.pop();
    }
  });

  var deepestFirst = Array.from(directories).sort(function (a, b) {
    return b.split("/").length - a.split("/").length;
  });

  for (var i = 0; i < deepestFirst.length; i++) {
    await fs.rmdir(path(blogID, deepestFirst[i])).catch(function () {});
  }
}

// Called after a file (or directory tree) has been written to
// path(blogID, relPath) by a tool that needed a local path. Uploads the file
// (every file, for a directory) and then deletes exactly the files it
// uploaded from staging, leaving any other file in the same directory alone.
// If an upload fails, the staged files are deleted and the error thrown.
// Nothing existing at relPath (e.g. a converter whose document had no media)
// is not an error.
async function commit(blogID, relPath) {
  var local = path(blogID, relPath);
  var rel = normalise(blogID, relPath);
  var stat;

  try {
    stat = await fs.stat(local);
  } catch (err) {
    if (isMissing(err)) return;
    throw err;
  }

  var files = [];

  if (!stat.isDirectory()) {
    files.push({ rel: rel, local: local });
  } else {
    for await (var file of walkLocal(local)) {
      files.push({ rel: rel ? rel + "/" + file : file, local: join(local, file) });
    }
  }

  var pool = createPool(COMMIT_CONCURRENCY);

  try {
    for (var i = 0; i < files.length; i++) {
      await pool.add(uploadAndRemove.bind(null, blogID, files[i]));
    }

    await pool.drain();
  } catch (err) {
    // add() rejects as soon as an earlier upload has failed. Wait for the
    // uploads still running to settle before failing, so none are left in
    // flight once the caller has been told, then clean up staging. The first
    // error is the one thrown.
    await pool.drain().catch(function () {});
    await Promise.all(
      files.map(function (f) {
        return fs.remove(f.local).catch(function () {});
      })
    );
    await removeEmptyDirectories(
      blogID,
      files.map(function (f) {
        return f.rel;
      })
    );

    throw err;
  }

  await removeEmptyDirectories(
    blogID,
    files.map(function (f) {
      return f.rel;
    })
  );
}

// Writes a Buffer or string to the bucket.
async function write(blogID, relPath, data) {
  await fs.outputFile(path(blogID, relPath), data);
  await commit(blogID, relPath);
}

// Copies (or, with move: true, moves) a local file into the bucket,
// replacing any object already at relPath.
async function writeFrom(blogID, relPath, srcPath, options) {
  options = options || {};

  var destination = path(blogID, relPath);

  await fs.ensureDir(dirname(destination));

  if (options.move) await fs.move(srcPath, destination, { overwrite: true });
  else await fs.copy(srcPath, destination);

  await commit(blogID, relPath);
}

async function read(blogID, relPath) {
  return fromS3(blogID, relPath, async function () {
    var data = await s3.get(keyFor(blogID, relPath));
    return Buffer.from(await data.Body.transformToByteArray());
  });
}

async function exists(blogID, relPath) {
  return !!(await s3.head(keyFor(blogID, relPath)));
}

// Names of the immediate children of a directory, or [] if it doesn't exist.
async function list(blogID, relDir) {
  var rel = normalise(blogID, relDir || "");
  var prefix = blogID + "/" + (rel ? rel + "/" : "");
  var found = new Set();

  for await (var entry of s3.listEntries(prefix, "/")) {
    var name = (entry.key || entry.prefix).slice(prefix.length).replace(/\/$/, "");

    // a "folder" placeholder object is the prefix itself
    if (name) found.add(name);
  }

  return Array.from(found).sort();
}

// Every file in a blog's asset scope, as relPaths with no leading slash.
async function* walk(blogID) {
  root(blogID);

  var prefix = blogID + "/";

  for await (var entry of s3.listEntries(prefix)) {
    var rel = entry.key.slice(prefix.length);

    if (rel && !/\/$/.test(rel)) yield rel;
  }
}

// A stream of the file's bytes, which errors with NotFoundError if there's no
// such file. The object is opened only when the stream is first read, so a
// caller can queue many streams without holding connections open.
function createReadStream(blogID, relPath) {
  // Throws if relPath tries to leave the blog's asset directory
  var objectKey = keyFor(blogID, relPath);
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
    return fromS3(blogID, relPath, async function () {
      return (await s3.get(objectKey)).Body;
    });
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
  var destination = join(config.tmp_directory, DOWNLOAD_DIRECTORY, blogID, rel);

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
// delete it. The object is downloaded to a cache in the tmp directory, which
// is not where path() stages files and is pruned with the rest of tmp.
async function ensureLocal(blogID, relPath) {
  return download(blogID, relPath);
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

// Sends an asset as the response, the way res.sendFile would send a file:
// Range, If-None-Match and If-Modified-Since are passed to S3, and the status
// (200, 206, 304, 416), validators and caching headers are set from its
// answer. Rejects with NotFoundError if the asset doesn't exist so callers can
// fall through or send a 404.
//   maxAge     milliseconds or an ms string, e.g. "1y"
//   immutable  adds the immutable Cache-Control directive
//   headers    extra response headers (they win over the defaults)
//   dotfiles   "allow" (default) or "ignore" to treat dotfiles as missing
async function serve(req, res, blogID, relPath, options) {
  // Throws if relPath tries to leave the blog's asset directory
  path(blogID, relPath);

  return serveS3(req, res, blogID, relPath, options || {});
}

// Removes a file or a whole directory, from the bucket and from staging if a
// tool left anything there. A missing path is not an error.
async function remove(blogID, relPath) {
  var local = path(blogID, relPath);

  // An empty relPath would be a scope-wide delete, which only removeAll does
  if (resolve(local) === resolve(root(blogID))) {
    throw new Error("storage/assets: remove needs a path inside the blog's asset directory");
  }

  await fs.remove(local).catch(function () {});
  await s3.remove(keyFor(blogID, relPath));
}

// Removes a blog's entire asset directory. This is only used by blog
// deletion. A bucket failure is never swallowed: the bucket is publicly
// readable for blog_* keys, so a delete which silently failed would leave a
// deleted blog's assets on the CDN. The error goes to the caller (blog
// deletion), which reports it and can be retried. Anything the blog has in
// staging or in the download cache goes too, best-effort; the realpath check
// which guarded the deletion of a blog's directory on disk still applies to
// the staging directory.
async function removeAll(blogID) {
  var folder = root(blogID);

  await s3.removePrefix(blogID + "/");

  var realpathToFolder;

  try {
    realpathToFolder = await fs.realpath(folder);
  } catch (err) {
    // Nothing was staged for this blog
    if (err.code !== "ENOENT") throw err;
  }

  if (realpathToFolder) {
    var realpathToRoot = await fs.realpath(stagingRoot());

    if (realpathToFolder.indexOf(realpathToRoot + sep) !== 0) {
      throw new Error("Could not safely remove directory: " + folder);
    }

    await fs.remove(realpathToFolder);
  }

  await fs
    .remove(join(config.tmp_directory, DOWNLOAD_DIRECTORY, blogID))
    .catch(function () {});
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
