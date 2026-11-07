var folder = require("storage/folder");
var ensure = require("helper/ensure");
var time = require("helper/time");
var extname = require("path").extname;
var Metadata = require("build/metadata");
var cheerio = require("cheerio");
var extend = require("helper/extend");
var convert = require("./convert");
var folderStat = require("build/converters/folderStat");

function is(path) {
  return [".rtf"].indexOf(extname(path).toLowerCase()) > -1;
}

async function read(blog, path) {
  ensure(blog, "object").and(path, "string");

  time("stat");

  var stat;

  try {
    stat = await folderStat(blog.id, path);
  } finally {
    time.end("stat");
  }

  time("readFile");

  var buffer;

  try {
    buffer = await folder.read(blog.id, path);
  } finally {
    time.end("readFile");
  }

  var text = buffer.toString("utf-8");

  var html = await convert(blog, text);
  var metadata = {};
  var $ = cheerio.load(html, { decodeEntities: false }, false);

  $("p").each(function (i) {
    if (i === 0 && $(this).prev().length) {
      return false;
    }

    var text = $(this).text();

    if (text.indexOf(":") === -1) return false;

    var key = text.slice(0, text.indexOf(":"));

    // Key has space
    if (/\s/.test(key.trim())) return false;

    var parsed = Metadata(text);

    if (parsed.html === text) return false;

    extend(metadata).and(parsed.metadata);

    if (parsed.html) {
      $(this).html(parsed.html.trim());
    } else {
      $(this).remove();
    }
  });

  html = $.html().trim();

  var metadataString = "<!--";

  for (var i in metadata) metadataString += "\n" + i + ": " + metadata[i];

  if (metadataString !== "<!--") {
    metadataString += "\n-->\n";
    html = metadataString + html;
  }

  return [html, stat];
}

// Called back with (err, html, stat); without a callback it resolves to
// [html, stat]
module.exports = { read: read, is: is, id: "rtf" };
