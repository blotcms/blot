var cheerio = require("cheerio");
var basename = require("path").basename;
var extname = require("path").extname;
var parse = require("url").parse;
var each_el = require("./each_el");
var fs = require("fs-extra");
var sharp = require("sharp");
var mime = require("mime-types");
var callOnce = require("helper/callOnce");
var assetDirectory = require("./asset_directory");
// Imported HTML can reference arbitrary, user-controlled image URLs, so route
// the download through the airlock's forward proxy (SSRF egress boundary)
// rather than the app container's direct network. Fails closed in production.
var fetch = require("helper/airlock").fetch;

// Consider using this algorithm to determine best part of alt tag or caption to use
// as the file's name:
// http://www.bearcave.com/misl/misl_tech/wavelets/compression/shannon.html
var TIMEOUT = 5 * 1000; // 10s

function download(url, _callback) {
  console.log("Attempting to download", url);

  var time;

  var callback = callOnce(function (err, data, format, headers) {
    console.log("Finishing attempt to download", url);
    clearTimeout(time);
    _callback(err, data, format, headers);
  });

  if (!require("url").parse(url).hostname)
    return callback(new Error("Failed to parse hostname: " + url));

  if (!url || url.indexOf("data:") === 0)
    return callback(new Error("Invalid URL: " + url));

  time = setTimeout(function () {
    console.log("Timing out downloading", url);
    callback(new Error("Timeout: >10s downloading " + url));
  }, TIMEOUT);

  fetch(url, { airlockLabel: "import/download_images" })
    .then(function (res) {
      if (!res.ok) {
        throw new Error("Bad status code: " + res.status);
      }

      console.log("Successfully downloaded", url);

      var headers = {
        contentType: res.headers.get("content-type"),
        contentDisposition: res.headers.get("content-disposition"),
      };

      return res.arrayBuffer().then(function (arrayBuffer) {
        return { arrayBuffer: arrayBuffer, headers: headers };
      });
    })
    .then(function (result) {
      const buffer = Buffer.from(result.arrayBuffer);
      sharp(buffer).metadata(function (err, metadata) {
        var format;
        if (metadata && metadata.format) {
          format = metadata.format;
        }

        callback(null, buffer, format, result.headers);
      });
    })
    .catch(function (err) {
      console.log("Failed to download", url, err);
      callback(err);
    });
}

function download_thumbnail(post, callback) {
  if (!post || !post.metadata || !post.metadata.thumbnail) return callback();

  var thumbnail = post.metadata.thumbnail;

  if (!thumbnail) return callback();

  download(thumbnail, function (err, data, format, headers) {
    if (err || !data) return callback();

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
  var changes = false;
  var $ = cheerio.load(post.html, { decodeEntities: false });

  // The directory is created lazily only if a download succeeds.
  download_thumbnail(post, function (err, thumbnail) {
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

        download(src, function (err, data, format, headers) {
          if (err || !data) {
            return next();
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
      function () {
        post.html = $.html();

        callback(null, post);
      }
    );
  });
};

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
