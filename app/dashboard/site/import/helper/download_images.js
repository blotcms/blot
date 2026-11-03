var cheerio = require("cheerio");
var basename = require("path").basename;
var extname = require("path").extname;
var parse = require("url").parse;
var each_el = require("./each_el");
var fs = require("fs-extra");
var mime = require("mime-types");
var assetDirectory = require("./asset_directory");
var boundedDownload = require("./download");
var lifecycle = require("../lifecycle");

// The jail re-encodes each image (app/sandbox/jobs/fetch.js), so what is
// written is what libvips made of it and its format is known. One that isn't a
// JPEG, PNG, GIF or WebP stays a remote link.
function download(url, prefetched, callback) {
  boundedDownload(url, { kind: "image", prefetched })
    .then(({ data, format, headers }) => {
      lifecycle.check();
      return { data, format, headers: {
        contentType: headers.get("content-type"),
        contentDisposition: headers.get("content-disposition"),
      }};
    })
    .then(result => callback(null, result.data, result.format, result.headers), callback);
}

function download_thumbnail(post, prefetched, callback) {
  if (!post || !post.metadata || !post.metadata.thumbnail) return callback();

  var thumbnail = post.metadata.thumbnail;

  if (!thumbnail) return callback();

  download(thumbnail, prefetched, function (err, data, format, headers) {
    if (err || !data) return callback(lifecycle.current() && lifecycle.current().signal.aborted ? err : null);

    var name = nameFrom(thumbnail, headers, format);

    assetDirectory(post, function (err, directory) {
      if (err) return callback(err);

      fs.outputFile(directory + "/" + name, data, function (err) {
        if (err) return callback(err);
        callback(null, name);
      });
    });
  });
}

module.exports = function download_images(post, callback) {
  var $ = cheerio.load(post.html, { decodeEntities: false });

  // The post's images in one jail, where there are several
  var urls = [post.metadata && post.metadata.thumbnail];
  $("img").each(function (i, el) {
    urls.push($(el).attr("src"));
  });

  boundedDownload
    .prefetch(urls.filter(Boolean), { kind: "image" })
    .then(function (prefetched) {
      downloadAll(post, $, prefetched, callback);
    }, callback);
};

function downloadAll(post, $, prefetched, callback) {
  var changes = false;

  // The directory is created lazily only if a download succeeds.
  download_thumbnail(post, prefetched, function (err, thumbnail) {
    if (err) return callback(err);

    if (thumbnail) {
      changes = true;
      post.metadata.thumbnail = thumbnail;
    }

    each_el(
      $,
      "img",
      function (el, next) {
        var src = $(el).attr("src");

        if (!src) return next();

        download(src, prefetched, function (err, data, format, headers) {
          if (err || !data) {
            return next(lifecycle.current() && lifecycle.current().signal.aborted ? err : null);
          }

          var name = nameFrom(src, headers, format);

          assetDirectory(post, function (err, directory) {
            if (err) return next();

            fs.outputFile(directory + "/" + name, data, function (err) {
              if (err) return next();
              changes = true;

              $(el).attr("src", name);

              if ($(el).parent().attr("href") === src)
                $(el).parent().attr("href", name);

              next();
            });
          });
        });
      },
      function (err) {
        if (err) return callback(err);
        post.html = $.html();

        callback(null, post);
      }
    );
  });
}

function nameFrom(src, headers, format) {
  var name =
    filenameFromContentDisposition(headers && headers.contentDisposition) ||
    basename(parse(src).pathname) ||
    "image";

  try {
    name = decodeURIComponent(name);
  } catch (e) {
    // keep the raw name if it isn't valid percent-encoding
  }

  name = sanitizeFilename(name);

  if (name.charAt(0) !== "_") name = "_" + name;

  return ensureExtension(name, headers, format);
}

function filenameFromContentDisposition(header) {
  if (!header) return;

  // filename*=UTF-8''encoded-name.jpg
  var star = /filename\*\s*=\s*(?:UTF-8''|utf-8'')([^;]+)/i.exec(header);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^["']|["']$/g, ""));
    } catch (e) {
      // fall through
    }
  }

  // filename="Koa Etymology Pie Chart.jpg"
  var quoted = /filename\s*=\s*"((?:\\.|[^"])*)"/i.exec(header);
  if (quoted) return quoted[1].replace(/\\(.)/g, "$1");

  var unquoted = /filename\s*=\s*([^;]+)/i.exec(header);
  if (unquoted) return unquoted[1].trim().replace(/^['"]|['"]$/g, "");
}

function sanitizeFilename(name) {
  return String(name)
    .replace(/[/\\?%*:|"<>]/g, "-")
    .replace(/\0/g, "")
    .trim()
    .replace(/\s+/g, "_");
}

function ensureExtension(name, headers, format) {
  if (extname(name)) return name;

  var ext =
    extensionFromContentType(headers && headers.contentType) ||
    normalizeFormat(format);

  if (ext) return name + "." + ext;

  return name;
}

function extensionFromContentType(contentType) {
  if (!contentType) return;

  var type = String(contentType).split(";")[0].trim().toLowerCase();
  var ext = mime.extension(type);

  return ext || undefined;
}

function normalizeFormat(format) {
  if (!format) return;

  format = String(format).toLowerCase();

  // sharp reports "jpeg"; prefer the common file extension
  if (format === "jpeg") return "jpg";

  return format;
}

// Exported for tests
module.exports._nameFrom = nameFrom;
module.exports._filenameFromContentDisposition = filenameFromContentDisposition;
