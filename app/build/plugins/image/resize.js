var debug = require("debug")("blot:entry:build:plugins:images");
var sandbox = require("sandbox");
var ensure = require("helper/ensure");
var tempDir = require("helper/tempDir")();
var fs = require("fs-extra");
var { v4: uuid } = require("uuid");
var extname = require("path").extname;

// We don't do .gif because sharp cannot handle animated
// gifs at the moment. Perhaps in future...
var RESIZE_EXTENSION_WHITELIST = [".jpg", ".jpeg", ".png"];

module.exports = function (path, callback) {
  ensure(path, "string").and(callback, "function");

  var output = tempDir + uuid();
  var extension = extname(path).toLowerCase();

  // Since this image is not one we can resize, we fetch
  // its dimensions and continue...
  if (RESIZE_EXTENSION_WHITELIST.indexOf(extension) === -1) {
    debug("Fetching metadata for", path);
    return sandbox.run("metadata", {}, { path: path }).then(function (result) {
      callback(null, result.meta);
    }, callback);
  }

  debug("Resizing", path);

  // The sandbox does the sharp work (app/sandbox/jobs/resize.js) and the
  // resized file is written to a temporary file here and moved over the original
  sandbox.run("resize", { max: 3000, extension: extension }, { path: path }).then(function (result) {
    var info = result.meta;

    if (!info || !result.outputs.length) return callback("No info");

    fs.writeFile(output, result.outputs[0], function (err) {
      if (err) return callback(err);

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
  }, callback);
};
