var config = require("./config");
var FORMATS = config.FORMATS;
var MIN_WIDTH = config.MIN_WIDTH;
var MIN_HEIGHT = config.MIN_HEIGHT;

// What the thumbnail job is told to accept (app/sandbox/jobs/thumbnail.js),
// so it checks a candidate and makes its thumbnails in one jail
var ACCEPT = { formats: FORMATS, minWidth: MIN_WIDTH, minHeight: MIN_HEIGHT };

// Why an image can't be a thumbnail, from its { format, width, height } as the
// job read them, or null if it can
function check(info) {
  if (!info || !info.format) return new Error("Could not read file info");

  var format = info.format.toLowerCase();

  if (FORMATS.indexOf(format) === -1)
    return new Error("Image (" + format + ") is not a supported format");

  if (info.width < MIN_WIDTH)
    return new Error("Image (" + info.width + "px wide) is too small");

  if (info.height < MIN_HEIGHT)
    return new Error("Image (" + info.height + "px tall) is too small");

  return null;
}

module.exports = { check: check, ACCEPT: ACCEPT };
