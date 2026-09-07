var debug = require("debug")("blot:helper:transformer");
var client = require("models/client");
var isURL = require("./isURL");
var Keys = require("./keys");
var HashFile = require("./hash");
var download = require("./download");
var type = require("../type");
var ensure = require("../ensure");
var fs = require("fs-extra");
var localPath = require("../localPath");
var config = require("config");
var join = require("path").join;
var resolve = require("path").resolve;
var async = require("async");
var caseSensitivePath = require("../caseSensitivePath");
var he = require("he");

// Maps https://cdn.blot.im/blog_xyz/_image_cache/abc.jpg to
// /_image_cache/abc.jpg to enable us to look up the file quickly
// on disk without making an HTTP request
function resolveCDNPath(src) {
  if (src.indexOf(config.cdn.origin) !== 0) return src;

  try {
    // First we remove the protocol and CDN host
    src = src.slice(config.cdn.origin.length);

    // Now we remove the blog ID from the path on the CDN
    src = src.split("/").slice(2).join("/");
    return src;
  } catch (e) {
    return src;
  }
}

function Transformer(blogID, name) {
  ensure(blogID, "string").and(name, "string");

  var keys = Keys(blogID, name);

  // Note: lookup does NOT de-duplicate concurrent calls for the same source
  // (only repeat calls once a result is cached). Simultaneous callers each
  // run the transform. They write the same content-hash key so the last
  // write wins; a non-deterministic or file-writing transform - e.g. the
  // image cache's optimize(), which mints a uuid per call - can therefore
  // leave an orphaned artifact. Accepted trade-off, not a bug; see
  // readme.txt.
  function lookup(src, transform, callback) {
    if (type(src) !== "string") {
      return callback(new Error("Transformer: src is not a string"));
    }

    if (type(transform) !== "function") {
      return callback(new Error("Transformer: transformer is not a function"));
    }

    src = resolveCDNPath(src);

    var url = isURL(src);
    var path = src;
    var decodedURI;
    var fullLocalPath;
    var tasks = [];

    debug(src);

    // We check URLs first since isPath is less strict
    if (url) {
      debug(src, "seemes to be a URL");
      return fromURL(url, transform, callback);
    }

    if (path.length > 300) {
      return callback(new Error("Transformer: source too long: " + clip(src)));
    }

    if (path.indexOf("data:") === 0) {
      return callback(new Error("Transformer: source is unsupported protocol"));
    }

    // We try and look up the URI-decoded version of a path
    // to map "/Hello%20world.txt" to "/Hello word.txt".
    try {
      decodedURI = decodeURI(path);
      decodedURI = he.decode(decodedURI);
    } catch (e) {
      // Can throw an error for a malformed path
      decodedURI = null;
    }

    // Images pulled from Word Documents are stored in the static folder.
    // `src` comes from an <img src> in the rendered entry, so a value like
    // "../../<other blog id>/secret.jpg" must not be able to climb out of
    // this blog's own static directory. resolve("/", src) strips any "../"
    // and yields an absolute path, which join() then re-roots under the
    // blog's folder - the same containment trick helper/localPath uses.
    tasks.push(function (next) {
      var staticRoot = join(config.blog_static_files_dir, blogID);
      fullLocalPath = join(staticRoot, resolve("/", src));
      fromPath(fullLocalPath, transform, next);
    });

    // If we make it here, the file doesn't match anything in the static
    // folder. We don't need to look further inside the static folder since
    // those paths are added by Blot and guaranteed correct and lowercase.

    // First we check if this path matches a file in the blog folder exactly.
    tasks.push(function (next) {
      debug("attempting to resolve path exactly");
      fullLocalPath = localPath(blogID, path);
      fromPath(fullLocalPath, transform, next);
    });

    // Next we attempt to resolve the path case-insensitively
    tasks.push(function (next) {
      debug("attempting to resolve path case-insensitively");
      caseSensitivePath(
        localPath(blogID, "/"),
        path,
        function (err, fullLocalPath) {
          if (err) return next(err);
          fromPath(fullLocalPath, transform, next);
        }
      );
    });

    // Finally we attempt to resolve the URI-decoded path case-insensitively
    if (decodedURI)
      tasks.push(function (next) {
        debug(
          "attempting to resolve URI-decoded path case-insensitively",
          decodedURI
        );
        caseSensitivePath(
          localPath(blogID, "/"),
          decodedURI,
          function (err, fullLocalPath) {
            if (err) return next(err);
            fromPath(fullLocalPath, transform, next);
          }
        );
      });

    // If the path contains a backward slash, we try and resolve it as if
    // it were a forward path. This is to handle users used to the
    // Windows convention of backward slashes in paths.
    if (path.indexOf("\\") !== -1) {
      // first with the original case
      tasks.push(function (next) {
        var backslashPath = path.split("\\").join("/");
        debug("attempting to resolve backslash path", backslashPath);
        fullLocalPath = localPath(blogID, backslashPath);
        fromPath(fullLocalPath, transform, next);
      });

      // then case-insensitively
      tasks.push(function (next) {
        var backslashPath = path.split("\\").join("/");
        debug("attempting backslash path case-insensitively", backslashPath);
        caseSensitivePath(
          localPath(blogID, "/"),
          backslashPath,
          function (err, fullLocalPath) {
            if (err) return next(err);
            fromPath(fullLocalPath, transform, next);
          }
        );
      });

      // then URI-decoded and case-insensitively
      if (decodedURI)
        tasks.push(function (next) {
          var backslashPath = decodedURI.split("\\").join("/");
          debug(
            "attempting backslash URI-decoded path case-insensitively",
            backslashPath
          );
          caseSensitivePath(
            localPath(blogID, "/"),
            backslashPath,
            function (err, fullLocalPath) {
              if (err) return next(err);
              fromPath(fullLocalPath, transform, next);
            }
          );
        });
    }

    // Will work down the list of paths. If one of the paths
    // works then it'll stop and return the result!
    async.tryEach(tasks, function (err, results) {
      if (err) return callback(err);
      debug(results);
      callback(null, results[0], results[1]);
    });
  }

  // callback must be passed an error or null and result
  function fromURL(url, transform, callback) {
    var tasks = [];

    // Look in the database to see if we have downloaded
    // this URL in the past. If so, retrieve the response
    // headers, hash of the file's content and the result
    // application of the 'transform' called 'result'
    getURL(url, function (err, headers, hash, result) {
      if (err) return callback(err);

      // Right now ampersands in URL queries are escaped
      // which isn't ideal and breaks the thumbnail generator.
      // So we try the URL with unescaped ampersands first.
      if (url.indexOf("&amp;") > -1) {
        tasks.push(function (next) {
          download(url.split("&amp;").join("&"), headers, next);
        });
      }

      tasks.push(function (next) {
        download(url, headers, next);
      });

      async.tryEach(tasks, function (err, results) {
        // Now we try and download the URL, passing in previously
        // stored headers if any. This module interprets 304
        // responses nicely.
        if (err) {
          if (result) return callback(null, result);
          return callback(err);
        }

        if (!Array.isArray(results)) results = [];

        var path = results[0];
        var newHeaders = results[1];

        if (newHeaders) headers = newHeaders;

        // We didn't redownload the file since it's
        if (!path && result) return callback(null, result);

        // Something went wrong, if there is no path, no error
        // and no result. So leave before breaking shit.
        if (!path && !result) return callback(missing(url));

        fromPath(path, transform, function (err, result, hash) {
          // The file was downloaded to the temp
          // directory so we remove it now...
          // do this before handling any errors...
          fs.remove(path);

          if (err) return callback(err);

          setURL(url, headers, hash, result, function (setErr) {
            // The transform already succeeded. A failed cache write must
            // not throw from this async callback (crash / hung build) or
            // discard the result - worst case we transform again next time.
            if (setErr) debug("failed to cache result for url", url, setErr);
            callback(null, result);
          });
        });
      });
    });
  }

  function fromPath(path, transform, callback) {
    ensure(path, "string").and(transform, "function").and(callback, "function");

    debug(path, "hashing file");

    HashFile(path, function (err, hash) {
      if (err) return callback(err);

      debug(path, "getting existing result from hash");
      get(hash, function (err, result) {
        // Leave early, please pass hash so that
        // from URL doesn't have to compute it again
        if (err || result) return callback(err, result, hash);

        debug(path, "transforming new file");
        transform(path, function (err, result) {
          if (err) return callback(err);

          // Pass hash so that
          // from URL doesn't have to compute it again
          debug(path, "saving result of new transform");
          set(hash, result, function (setErr) {
            // Never throw from this async callback. If the cache write
            // fails, still return the freshly computed result rather than
            // hanging the build or crashing the process.
            if (setErr) debug("failed to cache result for hash", hash, setErr);
            callback(null, result, hash);
          });
        });
      });
    });
  }

  function getURL(url, callback) {
    var info = [keys.url.headers(url), keys.url.content(url)];

    (async function () {
      try {
        const res = await client.mGet(info);

        var headers = null;
        var hash = null;

        try {
          headers = JSON.parse(res[0]);
          hash = res[1];
        } catch (e) {}

        if (hash === null) return callback(null, headers, hash, null);

        get(hash, function (err, result) {
          callback(err, headers, hash, result);
        });
      } catch (err) {
        callback(err);
      }
    })();
  }

  function get(hash, callback) {
    (async function () {
      try {
        const stringifiedResult = await client.get(keys.content(hash));

        var res = null;

        try {
          res = JSON.parse(stringifiedResult);
        } catch (e) {}

        return callback(null, res);
      } catch (err) {
        callback(err);
      }
    })();
  }

  function setURL(url, headers, hash, result, callback) {
    callback = callback || nothing;

    ensure(url, "string")
      .and(headers, "object")
      .and(hash, "string")
      .and(result, "object")
      .and(callback, "function");

    var urlContentKey = keys.url.content(url);
    var urlHeadersKey = keys.url.headers(url);
    var contentKey = keys.content(hash);

    var stringifiedHeaders = JSON.stringify(headers);
    var stringifiedResult = JSON.stringify(result);

    (async function () {
      try {
        const tx = client.multi();
        tx.sAdd(keys.everything, [contentKey, urlContentKey, urlHeadersKey]);
        tx.mSet({
          [urlContentKey]: hash,
          [urlHeadersKey]: stringifiedHeaders,
          [contentKey]: stringifiedResult,
        });
        await tx.exec();
        callback();
      } catch (err) {
        callback(err);
      }
    })();
  }

  function set(hash, result, callback) {
    callback = callback || nothing;

    ensure(hash, "string").and(result, "object").and(callback, "function");

    var stringifiedResult = JSON.stringify(result);
    var contentKey = keys.content(hash);

    (async function () {
      try {
        const tx = client.multi();
        tx.sAdd(keys.everything, contentKey);
        tx.set(contentKey, stringifiedResult);
        await tx.exec();
        callback();
      } catch (err) {
        callback(err);
      }
    })();
  }

  function flush(callback) {
    (async function () {
      try {
        const toDelete = await client.sMembers(keys.everything);
        if (toDelete && toDelete.length) {
          await client.del(toDelete);
        }
        callback();
      } catch (err) {
        callback(err);
      }
    })();
  }

  return {
    lookup: lookup,
    flush: flush,
  };
}

function nothing(err) {
  // Default callback for fire-and-forget cache writes. Swallow the error
  // (log under debug) - throwing here would surface as an unhandled
  // rejection from the async write and take down the process.
  if (err) debug("transformer: ignored cache write error", err);
}

function missing(src) {
  return new Error("Transformer: URL could not be downloaded: " + clip(src));
}

function clip(src) {
  if (src.length > 50)
    src =
      src.slice(0, 50) + "... (" + (src.length - 50) + " characters removed)";
  return src;
}

module.exports = Transformer;
