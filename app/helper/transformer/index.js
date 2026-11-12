var debug = require("debug")("blot:helper:transformer");
var client = require("models/client");
var blogKey = require("models/blog/key");
var isURL = require("./isURL");
var Keys = require("./keys");
var HashFile = require("./hash");
var download = require("./download");
var ownHost = require("./ownHost");
var type = require("../type");
var ensure = require("../ensure");
var fs = require("fs-extra");
var folder = require("storage/folder");
var config = require("config");
var assets = require("storage/assets");
var resolve = require("path").resolve;
var he = require("he");
var unwrapFolderLink = require("blog/render/replaceFolderLinks/unwrapFolderLink");
var decodeFolderPath =
  require("blog/render/replaceFolderLinks/shared").decodeFolderPath;

// Tries each task (an async function) in turn until one doesn't fail, then
// resolves with that task's result. If every task fails it throws the last
// error. Tasks run one after another, never together.
async function tryEach(tasks) {
  var error = null;

  for (var task of tasks) {
    try {
      return await task();
    } catch (err) {
      error = err;
    }
  }

  if (error) throw error;
}

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

// A build-time consumer of an <img src> that runs after
// app/build/plugins/folderAssets in the pipeline (e.g. app/build/thumbnail,
// called from app/build/index.js on the same post-plugin html) sees the
// baked %%BLOT_CDN%%/folder/v-<hash>/<blogID><path> link instead of a
// local path. Map it back to <path>. Only the token form matters: every
// caller of Transformer.lookup() sees build-time HTML, which never
// contains the real CDN origin (middleware.js substitutes that per request).
function resolveFolderCDNPath(src, blogID) {
  var unwrapped = unwrapFolderLink(src, blogID);

  if (unwrapped === null) return src;

  // unwrapFolderLink keeps any ?query/#hash, which aren't part of the
  // file's path on disk, and leaves the path percent-encoded.
  var cutIndex = unwrapped.search(/[?#]/);
  return decodeFolderPath(
    cutIndex === -1 ? unwrapped : unwrapped.slice(0, cutIndex)
  );
}

// Decodes percent-escapes, or returns the string as it is if malformed
function safeDecodeComponent(string) {
  try {
    return decodeURIComponent(string);
  } catch (e) {
    return string;
  }
}

function Transformer(blogID, name) {
  ensure(blogID, "string").and(name, "string");

  var keys = Keys(blogID, name);

  // Fetched lazily (only once a URL actually needs to be checked) and
  // memoized for the life of this Transformer, so instances used purely
  // for local paths never pay for this lookup.
  var ownHostnamesPromise;

  async function fetchOwnHostnames() {
    try {
      var res = await client.hmGet(blogKey.info(blogID), ["domain", "handle"]);
      return ownHost.hostnames({ domain: res[0], handle: res[1] });
    } catch (err) {
      debug(blogID, "failed to fetch own hostnames", err);
      return [];
    }
  }

  function getOwnHostnames() {
    if (!ownHostnamesPromise) ownHostnamesPromise = fetchOwnHostnames();

    return ownHostnamesPromise;
  }

  // Note: lookup does NOT de-duplicate concurrent calls for the same source
  // (only repeat calls once a result is cached). Simultaneous callers each
  // run the transform. They write the same content-hash key so the last
  // write wins; a non-deterministic or file-writing transform - e.g. the
  // image cache's optimize(), which mints a uuid per call - can therefore
  // leave an orphaned artifact. Accepted trade-off, not a bug; see
  // readme.txt.
  async function lookup(src, transform) {
    if (type(src) !== "string") {
      throw new Error("Transformer: src is not a string");
    }

    if (type(transform) !== "function") {
      throw new Error("Transformer: transformer is not a function");
    }

    src = resolveCDNPath(src);
    src = resolveFolderCDNPath(src, blogID);

    var url = isURL(src);
    var path = src;
    var decodedURI;
    var tasks = [];

    debug(src);

    // We check URLs first since isPath is less strict
    if (url) {
      // If this URL is hosted on the blog's own custom domain or its
      // <handle>.blot.im subdomain, it's very likely a local file being
      // referenced by its full URL rather than a relative path - fetching
      // it over HTTP just to get back bytes we already have on disk
      // needlessly slows builds down. Try resolving it as a local path
      // first (recursing back through this same function reuses every
      // local-path fallback below), and only hit the network if that
      // fails - e.g. the file has since been deleted, or the URL doesn't
      // actually map onto the folder.
      var ownHostnames = await getOwnHostnames();
      var ownPath = ownHost.resolve(url, ownHostnames);

      if (ownPath) {
        debug(
          src,
          "matches this blog's own domain, trying local path first:",
          ownPath
        );

        try {
          return await lookup(ownPath, transform);
        } catch (err) {
          debug(
            src,
            "local lookup for own-domain URL failed, falling back to network fetch:",
            err
          );
        }

        return await fromURL(url, transform);
      }

      debug(src, "seemes to be a URL");
      return await fromURL(url, transform);
    }

    if (path.length > 300) {
      throw new Error("Transformer: source too long: " + clip(src));
    }

    if (path.indexOf("data:") === 0) {
      throw new Error("Transformer: source is unsupported protocol");
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
    // blog's folder - the same containment trick storage/folder uses.
    tasks.push(function () {
      return fromAssets(src, transform);
    });

    // Generated assets with non-ASCII names (e.g. the image cache's
    // "_image_cache/{uuid}/说明.png") are linked with their names escaped,
    // so try the decoded path too.
    var decodedAssetPath = safeDecodeComponent(src);

    if (decodedAssetPath !== src)
      tasks.push(function () {
        return fromAssets(decodedAssetPath, transform);
      });

    // If we make it here, the file doesn't match anything in the static
    // folder. We don't need to look further inside the static folder since
    // those paths are added by Blot and guaranteed correct and lowercase.

    // First we check if this path matches a file in the blog folder exactly.
    tasks.push(function () {
      debug("attempting to resolve path exactly");
      return fromFolder(path, transform);
    });

    // Next we attempt to resolve the path case-insensitively
    tasks.push(function () {
      debug("attempting to resolve path case-insensitively");
      return fromFolderIgnoringCase(path, transform);
    });

    // Finally we attempt to resolve the URI-decoded path case-insensitively
    if (decodedURI)
      tasks.push(function () {
        debug(
          "attempting to resolve URI-decoded path case-insensitively",
          decodedURI
        );
        return fromFolderIgnoringCase(decodedURI, transform);
      });

    // If the path contains a backward slash, we try and resolve it as if
    // it were a forward path. This is to handle users used to the
    // Windows convention of backward slashes in paths.
    if (path.indexOf("\\") !== -1) {
      // first with the original case
      tasks.push(function () {
        var backslashPath = path.split("\\").join("/");
        debug("attempting to resolve backslash path", backslashPath);
        return fromFolder(backslashPath, transform);
      });

      // then case-insensitively
      tasks.push(function () {
        var backslashPath = path.split("\\").join("/");
        debug("attempting backslash path case-insensitively", backslashPath);
        return fromFolderIgnoringCase(backslashPath, transform);
      });

      // then URI-decoded and case-insensitively
      if (decodedURI)
        tasks.push(function () {
          var backslashPath = decodedURI.split("\\").join("/");
          debug(
            "attempting backslash URI-decoded path case-insensitively",
            backslashPath
          );
          return fromFolderIgnoringCase(backslashPath, transform);
        });
    }

    // Will work down the list of paths. If one of the paths
    // works then it'll stop and return the result!
    var found = await tryEach(tasks);
    debug(found);
    return found.result;
  }

  // The from* functions resolve with { result, hash }: the transform's result
  // and the hash of the file's content, so that fromURL doesn't have to
  // compute it again.

  // A file in the blog's generated assets
  async function fromAssets(path, transform) {
    var fullLocalPath = await assets.ensureLocal(blogID, resolve("/", path));
    return fromPath(fullLocalPath, transform);
  }

  // A file in the blog's folder, at exactly this path
  function fromFolder(path, transform) {
    // The transform (sharp, ffmpeg, exiftool) may run for longer than the
    // cache keeps a path, so the file is held until it is done
    return folder.withLocal(blogID, path, function (fullLocalPath) {
      return fromPath(fullLocalPath, transform);
    });
  }

  // The same, matching the path without regard to case
  async function fromFolderIgnoringCase(path, transform) {
    var resolvedPath = await folder.resolveCaseInsensitive(blogID, path);
    return fromFolder(resolvedPath, transform);
  }

  async function fromURL(url, transform) {
    var tasks = [];

    // Look in the database to see if we have downloaded
    // this URL in the past. If so, retrieve the response
    // headers, hash of the file's content and the result
    // application of the 'transform' called 'result'
    var stored = await getURL(url);
    var headers = stored.headers;
    var result = stored.result;

    // Right now ampersands in URL queries are escaped
    // which isn't ideal and breaks the thumbnail generator.
    // So we try the URL with unescaped ampersands first.
    if (url.indexOf("&amp;") > -1) {
      tasks.push(function () {
        return download(url.split("&amp;").join("&"), headers);
      });
    }

    tasks.push(function () {
      return download(url, headers);
    });

    var downloaded;

    // Now we try and download the URL, passing in previously
    // stored headers if any. This module interprets 304
    // responses nicely.
    try {
      downloaded = await tryEach(tasks);
    } catch (err) {
      if (result) return result;
      // So the image plugin can tell a failed download from a failed resize
      if (err && typeof err === "object") err.fromDownload = true;
      throw err;
    }

    var path = downloaded.path;

    if (downloaded.headers) headers = downloaded.headers;

    // We didn't redownload the file since it's
    if (!path && result) return result;

    // Something went wrong, if there is no path, no error
    // and no result. So leave before breaking shit.
    if (!path && !result) throw missing(url);

    var found;

    try {
      found = await fromPath(path, transform);
    } finally {
      // The file was downloaded to the temp
      // directory so we remove it now...
      // do this before handling any errors...
      fs.remove(path);
    }

    try {
      await setURL(url, headers, found.hash, found.result);
    } catch (setErr) {
      // The transform already succeeded. A failed cache write must
      // not discard the result - worst case we transform again next time.
      debug("failed to cache result for url", url, setErr);
    }

    return found.result;
  }

  async function fromPath(path, transform) {
    ensure(path, "string").and(transform, "function");

    debug(path, "hashing file");

    var hash = await HashFile(path);

    debug(path, "getting existing result from hash");

    var existing = await get(hash);

    // Leave early, please pass hash so that
    // from URL doesn't have to compute it again
    if (existing) return { result: existing, hash: hash };

    debug(path, "transforming new file");

    var result = await transform(path);

    // Pass hash so that
    // from URL doesn't have to compute it again
    debug(path, "saving result of new transform");

    try {
      await set(hash, result);
    } catch (setErr) {
      // If the cache write fails, still return the freshly computed
      // result rather than failing the build.
      debug("failed to cache result for hash", hash, setErr);
    }

    return { result: result, hash: hash };
  }

  async function getURL(url) {
    var info = [keys.url.headers(url), keys.url.content(url)];
    var res = await client.mGet(info);

    var headers = null;
    var hash = null;

    try {
      headers = JSON.parse(res[0]);
      hash = res[1];
    } catch (e) {}

    if (hash === null) return { headers: headers, hash: hash, result: null };

    var result = await get(hash);

    return { headers: headers, hash: hash, result: result };
  }

  async function get(hash) {
    var stringifiedResult = await client.get(keys.content(hash));
    var res = null;

    try {
      res = JSON.parse(stringifiedResult);
    } catch (e) {}

    return res;
  }

  async function setURL(url, headers, hash, result) {
    ensure(url, "string")
      .and(headers, "object")
      .and(hash, "string")
      .and(result, "object");

    var urlContentKey = keys.url.content(url);
    var urlHeadersKey = keys.url.headers(url);
    var contentKey = keys.content(hash);

    var stringifiedHeaders = JSON.stringify(headers);
    var stringifiedResult = JSON.stringify(result);

    const tx = client.multi();
    tx.sAdd(keys.everything, [contentKey, urlContentKey, urlHeadersKey]);
    tx.mSet({
      [urlContentKey]: hash,
      [urlHeadersKey]: stringifiedHeaders,
      [contentKey]: stringifiedResult,
    });
    await tx.exec();
  }

  async function set(hash, result) {
    ensure(hash, "string").and(result, "object");

    var stringifiedResult = JSON.stringify(result);
    var contentKey = keys.content(hash);

    const tx = client.multi();
    tx.sAdd(keys.everything, contentKey);
    tx.set(contentKey, stringifiedResult);
    await tx.exec();
  }

  async function flush() {
    const toDelete = await client.sMembers(keys.everything);
    if (toDelete && toDelete.length) {
      await client.del(toDelete);
    }
  }

  return {
    lookup: lookup,
    flush: flush,
  };
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
