var time = require("helper/time");
var pandoc = require("build/converters/pandoc");
var debug = require("debug")("blot:converters:rtf");
var withCallback = require("helper/withCallback");
var cheerio = require("cheerio");
var normalizeLiteralDollarMath =
  require("build/math/normalizeLiteralDollars").normalizeLiteralDollarMath;

async function convert(blog, text) {
  debug("Pre-pandoc", text);
  time("pandoc");

  var output;

  try {
    output = await pandoc({ from: "rtf" }, Buffer.from(text, "utf8"));
  } finally {
    time.end("pandoc");
  }

  var result = output.html;

  var $ = cheerio.load(result, { decodeEntities: false }, false);
  normalizeLiteralDollarMath($);
  result = $.html();

  debug("Final:", result);
  return result;
}

// The katex specs call this with a callback
module.exports = withCallback(convert);
