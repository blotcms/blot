var Transformer = require("helper/transformer");
var debug = require("debug")("blot:entry:build:plugins:image");
var optimize = require("./optimize");
var url = require("url");
var isURL = require("helper/transformer/isURL");
var { report } = require("build/flags");
var assets = require("storage/assets");
var config = require("config");

// Images looked up at once for one entry. A lookup whose result is cached
// costs a few Redis reads, so several overlap. One that isn't runs a sandbox
// job (a fresh jail, ~70ms before any work) through the broker, which runs
// two image decodes a unit at once and refuses jobs once its queue is full,
// so an entry still transforms only TRANSFORMS at a time.
var CONCURRENCY = 8;
var TRANSFORMS = 2;

// Runs fn with at most `limit` calls of one limiter in flight
function limiter(limit) {
  var running = 0;
  var waiting = [];

  return async function (fn) {
    if (running >= limit) await new Promise((resolve) => waiting.push(resolve));
    running++;
    try {
      return await fn();
    } finally {
      running--;
      if (waiting.length) waiting.shift()();
    }
  };
}

// What went wrong fetching a remote image. The downloader's error for an
// HTTP failure is just the status, e.g. "404".
function describeDownloadError(err) {
  var message = String((err && err.message) || "");

  if (/^\d{3}$/.test(message)) return "HTTP " + message;
  return message || "could not be downloaded";
}

// The src of the image that will be the post's first thumbnail candidate
// (build/thumbnail/candidates.js: the first <img> with a src, unless a video
// embed comes first), or null if the thumbnail isn't taken from the post's
// images. Only a guess: a wrong one costs thumbnails nobody uses, since they
// are kept by the image's bytes, never a wrong thumbnail.
function firstCandidateSrc($) {
  var found = null;

  $("img, .videoContainer iframe").each(function (i, el) {
    if (found !== null) return false;

    if (el.name !== "img") {
      found = "";
      return false;
    }

    var src = $(el).attr("src");
    if (src) found = src;
  });

  return found || null;
}

async function render($, { blogID, seedThumbnail }) {
  var cache = new Transformer(blogID, "image-cache");

  // A cached result is found by the image's bytes, so it may be one built long
  // ago, whose file has since gone from storage (removed, or never uploaded).
  // If so, the image is made again rather than linked. The result holds the
  // file's CDN URL, not its path, so the path is taken back out of it. A
  // result which isn't one of ours counts as valid.
  var urlPrefix = config.cdn.origin + "/" + blogID + "/";

  async function isValid(result) {
    if (!result || typeof result.src !== "string") return true;
    if (result.src.indexOf(urlPrefix) !== 0) return true;

    var relativePath;

    try {
      relativePath = decodeURIComponent(result.src.slice(urlPrefix.length));
    } catch (e) {
      return true;
    }

    if (!relativePath) return true;

    return assets.existsRecently(blogID, relativePath);
  }

  // First collect each <img> with a cacheable src. The same src is looked up
  // once however often it appears in the entry, and distinct srcs run
  // CONCURRENCY at a time: serial lookups were what kept one image from
  // racing itself (see helper/transformer/readme.txt), and de-duplicating by
  // src keeps that. Concurrent transforms of one source can still happen
  // across independent builds (e.g. parallel entry rebuilds); the transformer
  // does not de-duplicate in-flight lookups by design.
  var els = [];
  var srcs = [];
  var thumbnailSrc = seedThumbnail ? firstCandidateSrc($) : null;

  $("img").each(function (i, el) {
    if (!el || el.name !== "img") return;

    var src = $(el).attr("src");
    var parsedSrc;

    // The image might not have an src attribute – it happens!
    if (!src) return;

    try {
      // Test for query string to skip caching & optimizing
      parsedSrc = url.parse(src, { parseQueryString: true });
      debug(src, "parsed into", parsedSrc);
    } catch (e) {
      return;
    }

    // We want to allow you to opt out of image caching We do not
    // cache images with the static query e.g. /image.jpg?static=1
    if (parsedSrc && parsedSrc.query && parsedSrc.query.static) {
      debug(src, "Image has 'static' URL param, skipping");
      return;
    }

    els.push({ el: el, src: src });
    if (srcs.indexOf(src) === -1) srcs.push(src);
  });

  // Keyed by src, which is any string, so no inherited keys (e.g. "constructor")
  var infos = Object.create(null);
  var transforming = limiter(TRANSFORMS);

  // Looks up one src. A failed lookup is logged and the image left alone.
  async function lookupSrc(src) {
    // Pass in the `pathname` component of the image src (no URL params or hash)
    // Also pass the original src so we can include the filename in the CDN URL
    var transform = optimize(blogID, src, {
      thumbnail: src === thumbnailSrc,
    });

    try {
      infos[src] = await cache.lookup(
        src,
        async function () {
          try {
            return await transforming(() => transform.apply(this, arguments));
          } catch (err) {
            if (err && typeof err === "object") err.fromTransform = true;
            throw err;
          }
        },
        { isValid }
      );
    } catch (err) {
      debug(src, "Optimize failed with Error:", err);

      // An image which could not be found is left to folderAssets, which
      // reports a broken image reference with its path as written
      if (err && err.fromTransform) {
        report({ code: "IMAGE_OPTIMIZE_FAILED", targets: [src] });
      } else if (
        isURL(src) &&
        err &&
        (err.fromDownload || /could not be downloaded/.test(err.message))
      ) {
        report({
          code: "REMOTE_IMAGE_FAILED",
          targets: [{ url: src, error: describeDownloadError(err) }],
        });
      }
    }
  }

  // Works through srcs in order, with at most CONCURRENCY lookups in flight
  var nextIndex = 0;
  async function worker() {
    while (nextIndex < srcs.length) {
      var src = srcs[nextIndex++];
      await lookupSrc(src);
    }
  }

  var workers = [];
  for (var w = 0; w < Math.min(CONCURRENCY, srcs.length); w++)
    workers.push(worker());
  await Promise.all(workers);

  els.forEach(function (item) {
    var el = item.el;
    var src = item.src;
    var info = infos[src];
    var width, height;

    if (!info) return;

    // Replace the image's source with the new
    // source, which is a path to an image in the
    // static assets folder for this blog.
    $(el).attr("src", info.src);

    // Now we will attempt to declare the width and
    // height of the image to speed up page loads...
    if ($(el).attr("width") || $(el).attr("height")) {
      debug(src, "El has width or height pre-specified dont modify");
      return;
    }

    width = info.width;
    height = info.height;

    // This is a retina image so halve its dimensions
    if ($(el).attr("data-2x") || isRetina(src)) {
      debug(src, "retinafying the dimensions");
      height /= 2;
      width /= 2;
    }

    $(el).attr("width", width).attr("height", height);

    debug(src, "complete!");
  });
}

function isRetina(url) {
  return url && url.toLowerCase && url.toLowerCase().indexOf("@2x") > -1;
}

module.exports = {
  render,
  category: "images",
  title: "Cache",
  description: "Cache and optimize images",
};
