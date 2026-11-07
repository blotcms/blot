var promiseOnly = require("helper/promiseOnly");
var assets = require("storage/assets");
var { v4: uuid } = require("uuid");
var join = require("path").join;
var fs = require("fs-extra");
var cache_folder_name = "_image_cache";
var resize = require("./resize");
var extname = require("path").extname;
var basename = require("path").basename;
var debug = require("debug")("blot:entry:build:plugins:image");
var makeSlug = require("helper/makeSlug");
var removeDiacritics = require("helper/removeDiacritics");
var Url = require("url");

// Only cache images with the following file extensions
// We only resize and optimize JPG and PNG.
var EXTENSION_WHITELIST = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg"];

// Decodes percent-escapes, leaving the string alone if it is malformed
// (e.g. a lone "%" or a sequence cut off mid-character).
function safeDecode(string) {
  try {
    return decodeURIComponent(string);
  } catch (e) {
    return string;
  }
}

// The slug used to name a cached image, from the <img> src. The src is
// percent-encoded, and makeSlug returns an encodeURI'd slug, so both are
// decoded: the slug names the file, and is escaped again when building URLs.
function filenameFromSrc(originalSrc) {
  if (!originalSrc) return null;

  try {
    var pathname = Url.parse(originalSrc).pathname || "";
    var filename = safeDecode(basename(pathname));
    if (!filename) return null;

    var ext = extname(filename);
    var baseName = ext ? filename.slice(0, -ext.length) : filename;
    var slug = safeDecode(removeDiacritics(makeSlug(baseName)));

    // Never let separators, control characters or replacement characters
    // (from a sequence cut off mid-character) into a file name
    // eslint-disable-next-line no-control-regex
    return slug.replace(/[/\\\u0000-\u001f�]/g, "");
  } catch (e) {
    debug("Failed to extract filename from originalSrc:", e);
    return null;
  }
}

// At most 50 characters, and at most 150 once URL-escaped (e.g. 16 Chinese
// characters), cut between code points
function truncateSlug(slug) {
  var chars = Array.from(slug).slice(0, 50);

  while (encodeURIComponent(chars.join("")).length > 150) chars.pop();

  return chars.join("");
}

module.exports = function (blogID, originalSrc) {
  // helper/transformer calls this with a path and waits for the promise
  return promiseOnly(async function optimizeImage(path) {
    // Extnames can sometimes be uppercase, we want to ensure that
    // this will work on case-sensitive file systems so we lowercase it...
    var extension = extname(path).toLowerCase();

    // Extract original filename from originalSrc if available
    var originalFilename = filenameFromSrc(originalSrc);

    // Build the final filename: UUID as directory, original filename as file
    var uuidPart = uuid();
    var name;
    var relativePath;

    if (originalFilename && originalFilename.length > 0) {
      // Format: {uuid}/{slugified-original-filename}.{ext}
      // Limit the original filename part to avoid overly long filenames,
      // and keep it short once escaped too: helper/transformer refuses
      // paths over 300 characters, which would lose the post's thumbnail
      var slugPart = truncateSlug(originalFilename);
      name = slugPart + extension;
      relativePath = uuidPart + "/" + name;
    } else {
      // Fallback to UUID-only if we couldn't extract original filename
      name = uuidPart + extension;
      relativePath = name;
    }

    var assetPath = cache_folder_name + "/" + relativePath;

    // The image is copied here, resized in place, and then committed.
    var finalPath = assets.path(blogID, assetPath);

    // The file is named after the decoded slug, so its name can contain
    // characters which need escaping in a URL (assets.url takes names as given)
    var src = assets.url(
      blogID,
      originalFilename
        ? cache_folder_name + "/" + uuidPart + "/" + encodeURIComponent(name)
        : assetPath
    );

    try {
      if (EXTENSION_WHITELIST.indexOf(extension) === -1)
        throw new Error("Image does not have an extension we can cache.");

      // Ensure the directory exists (in case we're using UUID as a subdirectory)
      var finalDir = assets.path(blogID, cache_folder_name);
      if (originalFilename && originalFilename.length > 0) {
        finalDir = join(finalDir, uuidPart);
      }

      debug("Ensuring directory exists:", finalDir);
      await fs.ensureDir(finalDir);

      debug("Copying", path, "to", finalPath);
      await fs.copy(path, finalPath);

      debug("Resizing", finalPath);
      var info = await resize(finalPath);

      if (!info.width || !info.height) throw new Error("No width or height");

      debug("Minifying", finalPath);

      info.src = src;

      await assets.commit(blogID, assetPath);

      return info;
    } catch (err) {
      // Wrap the work to clean up file if we encounter an error in this module
      // When transformer creates and cleans up a tmp file for us, can remove this.
      try {
        await assets.remove(blogID, assetPath);
      } catch (removeErr) {}

      throw err;
    }
  });
};
module.exports.filenameFromSrc = filenameFromSrc;
module.exports.truncateSlug = truncateSlug;
