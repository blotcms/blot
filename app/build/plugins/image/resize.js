var debug = require("debug")("blot:entry:build:plugins:images");
var sharp = require("sharp");
var ensure = require("helper/ensure");
var tempDir = require("helper/tempDir")();
var fs = require("fs-extra");
var { v4: uuid } = require("uuid");
var extname = require("path").extname;

// We don't do .gif because sharp cannot handle animated
// gifs at the moment. Perhaps in future...
var RESIZE_EXTENSION_WHITELIST = [".jpg", ".jpeg", ".png"];

// Sharp seems to cache files based on their
// path and not the contents of the file at
// a particular path. It was returning stale
// versions of a file in the blog's folder.
// Perhaps it might be smarter to copy the file
// to the temporary directory before operating on it?
// It's also possible that this is a bug in Sharp's
// caching that has been fixed in a more recent version
// or that still needs to be fixed. I should investigate.
sharp.cache(false);

module.exports = function (path, callback) {
  ensure(path, "string").and(callback, "function");

  var output = tempDir + uuid();
  var extension = extname(path).toLowerCase();
  var image;

  // Since this image is not one we can resize, we fetch
  // its dimensions and continue...
  if (RESIZE_EXTENSION_WHITELIST.indexOf(extension) === -1) {
    debug("Fetching metadata for", path);
    return sharp(path).metadata(callback);
  }

  try {
    debug("Resizing", path);
    image = sharp(path)
      .keepIccProfile()
      .rotate()
      .resize(3000, 3000, { withoutEnlargement: true, fit: "inside" });
  } catch (e) {
    return callback(e);
  }

  image.toFile(output, function (err, info) {
    if (err || !info) return callback(err || "No info");

    // Remove the unresized file
    fs.remove(path, function (err) {
      if (err) return callback(err);

      // Move the resized file
      fs.move(output, path, function (err) {
        if (err) return callback(err);

        return callback(null, info);
      });
    });
  });
};
