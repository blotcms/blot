var fs = require("fs-extra");
var time = require("helper/time");
var pandoc = require("build/converters/pandoc");
var assets = require("storage/assets");
var hash = require("helper/hash");
var debug = require("debug")("blot:converters:rtf");
var cheerio = require("cheerio");
var normalizeLiteralDollarMath =
  require("build/math/normalizeLiteralDollars").normalizeLiteralDollarMath;

// path is the document's, for the asset directory its images are written to,
// as the docx converter does: an RTF holds its images itself (\pict), and
// without them written out its <img> tags would point nowhere
async function convert(blog, text, path) {
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

  if (output.media.length && path) {
    var assetDir = "_assets/" + hash(path);

    $("img").each(function () {
      var src = $(this).attr("src") || "";

      // pandoc's path to a file it extracted becomes the file's asset URL
      if (src.indexOf(output.dir + "/") === 0)
        $(this).attr("src", "/" + assetDir + src.slice(output.dir.length));
    });

    for (var i = 0; i < output.media.length; i++) {
      await fs.outputFile(
        assets.path(blog.id, assetDir, output.media[i].name),
        output.media[i].data
      );
    }
    await assets.commit(blog.id, assetDir);
  }

  result = $.html();

  debug("Final:", result);
  return result;
}

module.exports = convert;
