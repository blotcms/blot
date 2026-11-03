var async = require("async");
var basename = require("path").basename;
var parse = require("url").parse;
var fs = require("fs-extra");
var htmlAssets = require("./html_assets");
var assetDirectory = require("./asset_directory");
var download = require("./download");
var lifecycle = require("../lifecycle");

module.exports = function download_audio(post, callback) {
  // The post's audio (each http(s) <audio src> once) is found by the sandbox's
  // parse-html job, not by Node
  htmlAssets.scan("audio", post.html).then(function (scanned) {
    // The post's audio in one jail, where there are several
    download
      .prefetch(scanned.urls, { kind: "file", check: "audio" })
      .then(function (prefetched) {
        downloadAll(post, scanned, prefetched, callback);
      }, callback);
  }, callback);
};

function downloadAll(post, scanned, prefetched, callback) {
  var replacements = [];

  async.eachSeries(
    scanned.urls,
    function (href, next) {
      var name;

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

              replacements.push([href, name]);

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

      // With nothing downloaded, the HTML is what the parser wrote back
      if (!replacements.length) {
        post.html = scanned.html;
        return callback(null, post);
      }

      htmlAssets.rewrite("audio", post.html, replacements).then(function (html) {
        post.html = html;
        callback(null, post);
      }, callback);
    }
  );
}

function nameFrom(src) {
  return "_" + basename(parse(src).pathname);
}
