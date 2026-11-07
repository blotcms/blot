var basename = require("path").basename;
var extname = require("path").extname;
var parse = require("url").parse;
var htmlAssets = require("./html_assets");
var fs = require("fs-extra");
var mime = require("mime-types");
var assetDirectory = require("./asset_directory");
var boundedDownload = require("./download");
var lifecycle = require("../lifecycle");
var withCallback = require("helper/withCallback");

// The jail re-encodes each image (app/sandbox/jobs/fetch.js), so what is
// written is what libvips made of it and its format is known. One that isn't a
// JPEG, PNG, GIF or WebP stays a remote link.
async function download(url, prefetched) {
  const { data, format, headers } = await boundedDownload(url, {
    kind: "image",
    prefetched,
  });
  lifecycle.check();
  return {
    data,
    format,
    headers: {
      contentType: headers.get("content-type"),
      contentDisposition: headers.get("content-disposition"),
    },
  };
}

function directoryOf(post) {
  return new Promise(function (resolve, reject) {
    assetDirectory(post, function (err, directory) {
      if (err) return reject(err);
      resolve(directory);
    });
  });
}

async function download_thumbnail(post, prefetched) {
  if (!post || !post.metadata || !post.metadata.thumbnail) return;

  var thumbnail = post.metadata.thumbnail;

  if (!thumbnail) return;

  var result;

  try {
    result = await download(thumbnail, prefetched);
  } catch (err) {
    if (lifecycle.current() && lifecycle.current().signal.aborted) throw err;
    return null;
  }

  if (!result.data) return null;

  var name = nameFrom(thumbnail, result.headers, result.format);
  var directory = await directoryOf(post);

  await fs.outputFile(directory + "/" + name, result.data);

  return name;
}

async function download_images(post) {
  // The post's images (each http(s) <img src> once) are found by the sandbox's
  // parse-html job, not by Node
  const scanned = await htmlAssets.scan("images", post.html);

  // The post's images in one jail, where there are several
  var urls = [post.metadata && post.metadata.thumbnail].concat(scanned.urls);

  const prefetched = await boundedDownload.prefetch(urls.filter(Boolean), {
    kind: "image",
  });

  return downloadAll(post, scanned, prefetched);
}

async function downloadAll(post, scanned, prefetched) {
  var replacements = [];

  // The directory is created lazily only if a download succeeds.
  var thumbnail = await download_thumbnail(post, prefetched);

  if (thumbnail) post.metadata.thumbnail = thumbnail;

  for (const src of scanned.urls) {
    var result;

    try {
      result = await download(src, prefetched);
    } catch (err) {
      if (lifecycle.current() && lifecycle.current().signal.aborted) throw err;
      continue;
    }

    if (!result.data) continue;

    var name = nameFrom(src, result.headers, result.format);

    try {
      var directory = await directoryOf(post);
      await fs.outputFile(directory + "/" + name, result.data);
    } catch (e) {
      continue;
    }

    replacements.push([src, name]);
  }

  // With nothing downloaded, the HTML is what the parser wrote back
  if (!replacements.length) {
    post.html = scanned.html;
    return post;
  }

  // Changes the src of each downloaded image, and the link around it
  // if that went to the same URL. From the post's own HTML, so it is
  // parsed and written once, as it was when Node did it.
  post.html = await htmlAssets.rewrite("images", post.html, replacements);
  return post;
}

module.exports = withCallback(download_images);

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
