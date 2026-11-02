var sandbox = require("sandbox");
var config = require("./config");
var FORMATS = config.FORMATS;
var MIN_WIDTH = config.MIN_WIDTH;
var MIN_HEIGHT = config.MIN_HEIGHT;
var debug = require("debug")("blot:entry:build:thumbnail:validate");

module.exports = function (path, callback) {
  var format, width, height;

  debug(path);
  sandbox.run("metadata", {}, { path: path }).then(function (result) {
    var err;
    var info = result.meta;

    if (!info || !info.format) {
      err = new Error("Could not read file info");
      return callback(err);
    }

    debug(path, info);
    format = info.format.toLowerCase();
    width = info.width;
    height = info.height;

    if (FORMATS.indexOf(format) === -1) {
      err = new Error("Image (" + format + ") is not a supported format");
      return callback(err);
    }

    if (width < MIN_WIDTH) {
      err = new Error("Image (" + width + "px wide) is too small");
      return callback(err);
    }

    if (height < MIN_HEIGHT) {
      err = new Error("Image (" + height + "px tall) is too small");
      return callback(err);
    }

    debug(path, "is valid");
    callback();
  }, callback);
};
