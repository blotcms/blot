var config = require("config");
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

module.exports = function (blogID, originalSrc) {
  return function (path, _callback) {
    // Extnames can sometimes be uppercase, we want to ensure that
    // this will work on case-sensitive file systems so we lowercase it...
    var extension = extname(path).toLowerCase();
    
    // Extract original filename from originalSrc if available
    var originalFilename = null;
    if (originalSrc) {
      try {
        // Parse the original src to get the filename
        var parsed = Url.parse(originalSrc);
        var pathname = parsed.pathname || "";
        var filename = basename(pathname);
        
        // Remove extension to get base name
        if (filename) {
          var ext = extname(filename);
          var baseName = ext ? filename.slice(0, -ext.length) : filename;
          // Apply makeSlug to the base name
          originalFilename = makeSlug(baseName);
          originalFilename = removeDiacritics(originalFilename);
        }
      } catch (e) {
        debug("Failed to extract filename from originalSrc:", e);
      }
    }
    
    // Build the final filename: UUID as directory, original filename as file
    var uuidPart = uuid();
    var name;
    var relativePath;
    
    if (originalFilename && originalFilename.length > 0) {
      // Format: {uuid}/{slugified-original-filename}.{ext}
      // Limit the original filename part to avoid overly long filenames
      var slugPart = originalFilename.slice(0, 50);
      name = slugPart + extension;
      relativePath = uuidPart + "/" + name;
    } else {
      // Fallback to UUID-only if we couldn't extract original filename
      name = uuidPart + extension;
      relativePath = name;
    }
    
    var finalPath = join(
      config.blog_static_files_dir,
      blogID,
      cache_folder_name,
      relativePath
    );

    var src =
      config.cdn.origin + "/" + blogID + "/" + cache_folder_name + "/" + relativePath;

    // Wrap callback to clean up file if we encounter an error in this module
    // When transformer creates and cleans up a tmp file for us, can remove this.
    var callback = function (err, info) {
      if (!err) return _callback(null, info);

      fs.remove(finalPath, function () {
        _callback(err, info);
      });
    };

    if (EXTENSION_WHITELIST.indexOf(extension) === -1)
      return callback(
        new Error("Image does not have an extension we can cache.")
      );

    // Ensure the directory exists (in case we're using UUID as a subdirectory)
    var finalDir = join(config.blog_static_files_dir, blogID, cache_folder_name);
    if (originalFilename && originalFilename.length > 0) {
      finalDir = join(finalDir, uuidPart);
    }
    
    debug("Ensuring directory exists:", finalDir);
    fs.ensureDir(finalDir, function (err) {
      if (err) return callback(err);
      
      debug("Copying", path, "to", finalPath);
      fs.copy(path, finalPath, function (err) {
      if (err) return callback(err);

      debug("Resizing", finalPath);
      resize(finalPath, function (err, info) {
        if (err) return callback(err);

        if (!info.width || !info.height)
          return callback(new Error("No width or height"));

        debug("Minifying", finalPath);
        // minify(finalPath, function(err){

        if (err) return callback(err);

        info.src = src;

        callback(null, info);
        // });
      });
      });
    });
  };
};
