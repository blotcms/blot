var cheerio = require("cheerio");
var basename = require("path").basename;
var parse = require("url").parse;
var each_el = require("./each_el");
var fs = require("fs-extra");
var assetDirectory = require("./asset_directory");
var download = require("./download");
var lifecycle = require("../lifecycle");

module.exports = function download_audio(post, callback) {
  var $ = cheerio.load(post.html, { decodeEntities: false });

  each_el(
    $,
    "audio",
    function (el, next) {
      var href = $(el).attr("src");
      var name;

      // Only fetchable http(s) URLs with a hostname; skip data: URIs and
      // anything unparseable, the same way the image importer does.
      if (!href || href.indexOf("data:") === 0) return next();
      if (!parse(href).hostname) return next();

      try {
        name = nameFrom(href);
      } catch (e) {
        return next();
      }

      if (name.charAt(0) !== "_") name = "_" + name;

      download(href, { airlockLabel: "import/download_audio" })
        .then(function ({ data }) {
          assetDirectory(post, function (err, directory) {
            if (err) return next();

            fs.outputFile(directory + "/" + name, data, function (err) {
              if (err) return next();

              $(el).attr("src", name);

              next();
            });
          });
        })
        .catch(function (err) {
          console.log("Audio error:", href, err && err.message);
          next(lifecycle.current() && lifecycle.current().signal.aborted ? err : null);
        });
    },
    function (err) {
      if (err) return callback(err);
      post.html = $.html();
      callback(null, post);
    }
  );
};

function nameFrom(src) {
  return "_" + basename(parse(src).pathname);
}
