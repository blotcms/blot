var time = require("helper/time");
var pandoc = require("util").callbackify(require("build/converters/pandoc"));
var debug = require("debug")("blot:converters:rtf");
var cheerio = require("cheerio");
var normalizeLiteralDollarMath = require(
  "build/math/normalizeLiteralDollars"
).normalizeLiteralDollarMath;

module.exports = function (blog, text, callback) {
  debug("Pre-pandoc", text);
  time("pandoc");
  pandoc({ from: "rtf" }, Buffer.from(text, "utf8"), function (err, output) {
    time.end("pandoc");

    if (err) return callback(err);

    var result = output.html;

    var $ = cheerio.load(result, { decodeEntities: false }, false);
    normalizeLiteralDollarMath($);
    result = $.html();

    debug("Final:", result);
    callback(null, result);
  });
};
