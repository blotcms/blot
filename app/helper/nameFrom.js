var Url = require("url");
var UID = require("./makeUid");
var makeSlug = require("./makeSlug");

var basename = require("path").basename;
var extname = require("path").extname;

function nameFrom(src) {
  var name;

  try {
    name = basename(Url.parse(src).pathname);

    var ext = extname(name) || "";

    if (ext) {
      name = name.slice(0, -ext.length);
    }

    // First we remove all non word chars
    // perhaps makeslug should have this option?
    // For some reason, encoded utf-8 chars break
    // when linked to on cloudfront or s3, unsure why.
    // try uploading 'inpüt.jpg' to see what happens.
    name = name.replace(/[^\w\-\s.]+/g, "");

    name = makeSlug(name) + ext;
    name = name.slice(-35);
  } catch (e) {}

  return name || UID(10);
}

module.exports = nameFrom;
