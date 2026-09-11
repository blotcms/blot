var fs = require("fs-extra");
var ensure = require("helper/ensure");
var makeUid = require("helper/makeUid");
var LocalPath = require("helper/localPath");
var extname = require("path").extname;
var execFile = require("child_process").execFile;
var cheerio = require("cheerio");
var Metadata = require("build/metadata");
var extend = require("helper/extend");
var join = require("path").join;
var config = require("config");
var Pandoc = config.pandoc.bin;
var tempDir = require("helper/tempDir");

function is (path) {
  return [".odt"].indexOf(extname(path).toLowerCase()) > -1;
}

function TempDir () {
  return tempDir() + makeUid(20);
}

function read (blog, path, callback) {
  ensure(blog, "object")
    .and(path, "string")
    .and(callback, "function");

  var localPath = LocalPath(blog.id, path);

  var outDir = TempDir();
  var outPath = outDir + "/out.html";

  var blogDir = join(config.blog_static_files_dir, blog.id);
  var assetDir = join(blogDir, "_assets");

  fs.ensureDir(outDir, function (err) {
    if (err) return callback(err);

    fs.stat(localPath, function (err, stat) {
      if (err) return callback(err);

      var args = [
        localPath,
        "-o",
        outPath,
        "--extract-media=" + assetDir,
        "-f",
        "odt",
        "-t",
        "html5",
        "-s",
        // Limit the heap size for the pandoc process
        // to prevent pandoc consuming all the system's
        // memory in corner cases
        "+RTS",
        "-M" + config.pandoc.maxmemory,
        "-RTS"
      ];

      var startTime = Date.now();
      execFile(
        Pandoc,
        args,
        { timeout: config.pandoc.timeout },
        function (err, stdout, stderr) {
          if (err) {
            return callback(
              new Error(
                "Pandoc exited in " +
                  (Date.now() - startTime) +
                  "ms (timeout=" +
                  config.pandoc.timeout +
                  "ms) with: " +
                  err +
                  " and message " +
                  stderr
              )
            );
          }

          fs.readFile(outPath, "utf-8", function (err, html) {
            // remove everything between '<!--[if lt IE 9]>' and '<![endif]-->' including those comments
            html = html.replace(
              /<!--\[if lt IE 9\]>[\s\S]*<!\[endif\]-->/g,
              ""
            );

            var $ = cheerio.load(html, { decodeEntities: false }, false);

            // all p that contain possible metadata are checked until one is encountered that does not
            // p that are entirely bold are turned into h tags
            // first p that is entirely bold is h1, next are all h2

            var metadata = {};

            // remove <style>, <meta> and <title>
            $("style").remove();
            $("meta").remove();
            $("title").remove();

            $("p").each(function (i) {
              if ($(this).children().length) return false;

              if (i === 0 && $(this).prev().length) {
                return false;
              }

              var text = $(this).text();

              if (text.indexOf(":") === -1) return false;

              var key = text.slice(0, text.indexOf(":"));

              // Key has space
              if (/\s/.test(key.trim())) return false;

              var parsed = Metadata(text);

              if (parsed.html === text) return false;

              extend(metadata).and(parsed.metadata);

              $(this).remove();
            });

            var titleTag = $("header h1");

            $("header").replaceWith(titleTag);

            // find titles
            // this is possibly? span id="h.ulrsxjddh07w" class="anchor">
            $("p").each(function () {
              var text = $(this).text();
              var strong = $(this).find("strong");
              var strongText = strong.text();
              var children = $(this).children();
              var hasH1 = $("body h1").length;

              if (
                children.length === 1 &&
                text &&
                strongText &&
                text === strongText
              ) {
                var title = $("<h1>");

                if (hasH1) title = $("<h2>");

                title.html(strong.html());

                $(this).replaceWith(title);
              }
            });

            $("a").each(function () {
              var text = $(this).text();
              var em = $(this).find("em");
              var emText = em.text();
              var children = $(this).children();

              if (children.length === 1 && text && emText && text === emText)
                $(this).html(em.html());
            });

            $("li").each(function () {
              var text = $(this).text();
              var blockquote = $(this).find("blockquote");
              var blockquoteText = blockquote.text();
              var children = $(this).children();

              if (
                children.length === 1 &&
                text &&
                blockquoteText &&
                text === blockquoteText
              )
                $(this).html(blockquote.html());
            });

            // fix image links etc...

            $("img").each(function () {
              var src = $(this).attr("src");

              if (src.indexOf(blogDir) === 0)
                $(this).attr("src", src.slice(blogDir.length));
            });

            html = ($.html() || "").trim();

            var metadataString = "<!--";

            for (var i in metadata)
              metadataString += "\n" + i + ": " + metadata[i];

            if (metadataString !== "<!--") {
              metadataString += "\n-->\n";
              html = metadataString + html;
            }

            callback(null, html, stat);
            fs.remove(outPath, function (err) {});
          });
        }
      );
    });
  });
}

module.exports = { read: read, is: is, id: "odt"};
