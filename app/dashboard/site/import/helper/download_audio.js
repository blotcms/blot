var cheerio = require("cheerio");
var basename = require("path").basename;
var parse = require("url").parse;
var each_el = require("./each_el");
var fs = require("fs-extra");
var assetDirectory = require("./asset_directory");
// Imported HTML can reference arbitrary, user-controlled audio URLs, so route
// the download through the airlock's forward proxy (SSRF egress boundary)
// rather than the app container's direct network. Fails closed in production.
// This replaces the unproxied `download` package, which was also never
// declared in package.json (it resolved only as a transitive dependency).
var fetch = require("helper/airlock").fetch;

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

      fetch(href, { airlockLabel: "import/download_audio" })
        .then(function (res) {
          if (!res.ok) {
            throw new Error("Bad status code: " + res.status);
          }
          return res.arrayBuffer();
        })
        .then(function (arrayBuffer) {
          var data = Buffer.from(arrayBuffer);

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
          next();
        });
    },
    function () {
      post.html = $.html();
      callback(null, post);
    }
  );
};

function nameFrom(src) {
  return "_" + basename(parse(src).pathname);
}
