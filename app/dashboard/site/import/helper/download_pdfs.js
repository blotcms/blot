var async = require("async");
var basename = require("path").basename;
var parse = require("url").parse;
var htmlAssets = require("./html_assets");
var fs = require("fs-extra");
var assetDirectory = require("./asset_directory");
var boundedDownload = require("./download");
var lifecycle = require("../lifecycle");

function download(url, prefetched, callback) {
  boundedDownload(url, { kind: "file", check: "pdf", prefetched }).then(
    ({ data }) => callback(null, data),
    callback
  );
}

module.exports = function download_pdfs(post, callback) {
  // if (post.html.indexOf('pdf-embedder') > -1) {
  //   console.log('<<- ', post.html, ' ->>');
  //   throw new Error();
  // }

  var reg = /\[pdf-embedder(.*)\]/gm;

  post.html = post.html.replace(reg, function (str, x) {
    if (x.indexOf("url=")) x = x.split("url=").join("href=");

    return "\n\n<a" + x + ">PDF</a>\n\n";
  });

  // post.html = post.html.split('\\[pdf-embedder url="').join('\n\n<a href="');
  // post.html = post.html.split('"\\]').join("</a>\n\n");

  // The post's links to a PDF (each http(s) <a href> ending in .pdf once) are
  // found by the sandbox's parse-html job, not by Node
  htmlAssets.scan("pdfs", post.html).then(function (scanned) {
    // The post's PDFs in one jail, where there are several
    boundedDownload
      .prefetch(scanned.urls, { kind: "file", check: "pdf" })
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

      console.log("Attempting to download", href);

      download(href, prefetched, function (err, data) {
        if (err) {
          console.log("PDF error:", href, err.name, err.statusCode);
          return next(
            lifecycle.current() && lifecycle.current().signal.aborted
              ? err
              : null
          );
        }

        assetDirectory(post, function (err, directory) {
          if (err) return next();

          fs.outputFile(directory + "/" + name, data, function (err) {
            if (err) return next();

            replacements.push([href, name]);

            next();
          });
        });
      });
    },
    function (err) {
      if (err) return callback(err);

      // With nothing downloaded, the HTML is what the parser wrote back
      if (!replacements.length) {
        post.html = scanned.html;
        return callback(null, post);
      }

      // Changes each downloaded link's href, and its text if that was the URL.
      // From the post's own HTML, so it is parsed and written once, as it was
      // when Node did it.
      htmlAssets.rewrite("pdfs", post.html, replacements).then(function (html) {
        post.html = html;
        callback(null, post);
      }, callback);
    }
  );
}

function nameFrom(src) {
  return "_" + basename(parse(src).pathname);
}
