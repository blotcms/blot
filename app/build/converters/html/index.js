var folder = require("storage/folder");
var ensure = require("helper/ensure");
var extname = require("path").extname;
var cheerio = require("cheerio");
var Metadata = require("build/metadata");
var normalizeLiteralDollarMath =
  require("build/math/normalizeLiteralDollars").normalizeLiteralDollarMath;
var postSourceSize = require("build/converters/post-source-size");
var folderStat = require("build/converters/folderStat");
var withResults = require("build/withResults");

function is(path) {
  return [".html", ".htm"].indexOf(extname(path).toLowerCase()) > -1;
}

async function read(blog, path) {
  ensure(blog, "object").and(path, "string");

  var stat = await folderStat(blog.id, path);

  if (stat.size > postSourceSize.HTML.bytes)
    throw postSourceSize.tooLargeError(postSourceSize.HTML);

  var buffer = await folder.read(blog.id, path);
  var contents = buffer.toString("utf-8");

  // Metadata must be extracted from the source, rather than from Cheerio's
  // serialization. In particular, serialization can encode characters in
  // metadata values (such as "&"), changing both the value and its slug.
  var parsed = Metadata(contents);
  var $ = cheerio.load(parsed.html, { decodeEntities: false }, false);
  normalizeLiteralDollarMath($);

  return [$.html(), stat, { preExtractedMetadata: parsed.metadata }];
}

// Called back with (err, html, stat, extras); without a callback it resolves
// to [html, stat, extras]
module.exports = { read: withResults(read), is: is, id: "html" };
