var cheerio = require("cheerio");
var basename = require("path").basename;
var parse = require("url").parse;
var each_el = require("./each_el");
var fs = require("fs-extra");
var assetDirectory = require("./asset_directory");
var boundedDownload = require("./download");
var lifecycle = require("../lifecycle");

function download(url, callback) {
  boundedDownload(url, { airlockLabel: "import/download_pdfs" })
    .then(({ data }) => callback(null, data), callback);
}

module.exports = function download_pdfs(post, callback) {
  var changes = false;

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

  var $ = cheerio.load(post.html, { decodeEntities: false });

  each_el(
    $,
    "a",
    function (el, next) {
      var href = $(el).attr("href");
      var name;

      try {
        name = nameFrom(href);
      } catch (e) {
        return next();
      }

      if (name.charAt(0) !== "_") name = "_" + name;

      if (require("path").extname(href) !== ".pdf") return next();

      console.log("Attempting to download", href);

      download(href, function (err, data) {
        if (err) {
          console.log("PDF error:", href, err.name, err.statusCode);
          return next(lifecycle.current() && lifecycle.current().signal.aborted ? err : null);
        }

        assetDirectory(post, function (err, directory) {
          if (err) return next();

          fs.outputFile(directory + "/" + name, data, function (err) {
            if (err) return next();

            if ($(el).text() === href) {
              $(el).text(name);
            }

            changes = true;

            $(el).attr("href", name);

            next();
          });
        });
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
