var Transformer = require("helper/transformer");
var debug = require("debug")("blot:entry:build:plugins:image");
var async = require("async");
var optimize = require("./optimize");
var url = require("url");

// Images looked up at once for one entry. Each lookup is a sandbox job (a
// fresh jail, ~70ms before any work), so two at a time overlap their start-up.
var CONCURRENCY = 2;

function render($, callback, options) {
  var blogID = options.blogID;
  var cache = new Transformer(blogID, "image-cache");

  // First collect each <img> with a cacheable src. The same src is looked up
  // once however often it appears in the entry, and distinct srcs run
  // CONCURRENCY at a time: serial lookups were what kept one image from
  // racing itself (see helper/transformer/readme.txt), and de-duplicating by
  // src keeps that. Concurrent transforms of one source can still happen
  // across independent builds (e.g. parallel entry rebuilds); the transformer
  // does not de-duplicate in-flight lookups by design.
  var els = [];
  var srcs = [];

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

  async.eachLimit(
    srcs,
    CONCURRENCY,
    function (src, next) {
      // Pass in the `pathname` component of the image src (no URL params or hash)
      // Also pass the original src so we can include the filename in the CDN URL
      cache.lookup(src, optimize(blogID, src), function (err, info) {
        if (err) {
          debug(src, "Optimize failed with Error:", err);
        } else {
          infos[src] = info;
        }
        next();
      });
    },
    function () {
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

      debug("Invoking callback now!");
      callback();
    }
  );
}

function isRetina(url) {
  return url && url.toLowerCase && url.toLowerCase().indexOf("@2x") > -1;
}

module.exports = {
  render: render,
  category: "images",
  title: "Cache",
  description: "Cache and optimize images",
};
