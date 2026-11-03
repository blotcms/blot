var cheerio = require("cheerio");
var basename = require("path").basename;
var parse = require("url").parse;
var each_el = require("./each_el");
var fs = require("fs-extra");
var assetDirectory = require("./asset_directory");
var download = require("./download");
var lifecycle = require("../lifecycle");

// Only fetchable http(s) URLs with a hostname; skip data: URIs and anything
// unparseable, the same way the image importer does.
function fetchable(href) {
  return !!href && href.indexOf("data:") !== 0 && !!parse(href).hostname;
}

module.exports = function download_audio(post, callback) {
  var $ = cheerio.load(post.html, { decodeEntities: false });

  // The post's audio in one jail, where there are several
  var urls = [];
  $("audio").each(function (i, el) {
    var href = $(el).attr("src");
    if (fetchable(href)) urls.push(href);
  });

  download
    .prefetch(urls, { kind: "file", check: "audio" })
    .then(function (prefetched) {
      downloadAll(post, $, prefetched, callback);
    }, callback);
};

function downloadAll(post, $, prefetched, callback) {
  each_el(
    $,
    "audio",
    function (el, next) {
      var href = $(el).attr("src");
      var name;

      if (!fetchable(href)) return next();

      try {
        name = nameFrom(href);
      } catch (e) {
        return next();
      }

      if (name.charAt(0) !== "_") name = "_" + name;

      download(href, { kind: "file", check: "audio", prefetched: prefetched })
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
}

function nameFrom(src) {
  return "_" + basename(parse(src).pathname);
}
