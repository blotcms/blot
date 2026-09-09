var fs = require("fs");
var ensure = require("helper/ensure");
var LocalPath = require("helper/localPath");
var time = require("helper/time");
var extname = require("path").extname;

var layout = require("./layout");
var convert = require("./convert");
var extractMetadata = require("build/metadata");
var yaml = require("yaml");
var extractBibAndCSL = require("./extractBibAndCSL");
var linebreaks = require("./linebreaks");
var postSourceSize = require("build/converters/post-source-size");

function is (path) {
  return (
    [".txt", ".text", ".md", ".markdown"].indexOf(extname(path).toLowerCase()) >
    -1
  );
}

function read (blog, path, callback) {
  ensure(blog, "object")
    .and(path, "string")
    .and(callback, "function");

  var localPath = LocalPath(blog.id, path);

  time("stat");

  fs.stat(localPath, function (err, stat) {
    time.end("stat");

    if (err) return callback(err);
    if (stat.size > postSourceSize.MARKDOWN.bytes)
      return callback(postSourceSize.tooLargeError(postSourceSize.MARKDOWN));

    time("readFile");

    fs.readFile(localPath, "utf-8", function (err, text) {
      time.end("readFile");

      if (err) return callback(err);

      // Normalize newlines. Windows does \r\n
      // Some strange text editor does \r\r.
      text = text.replace(/\r\r/gm, "\n\n");

      time("metadata");
      const parsed = extractMetadata(text);
      text = parsed.html;
      time.end("metadata");

      time("layout");
      text = layout(text);
      time.end("layout");

      if (blog.plugins.linebreaks.enabled) {
        time("linebreaks");
        text = linebreaks(text);
        time.end("linebreaks");
      }


      extractBibAndCSL(blog, path, parsed.metadata, function (err, bib, csl) {
        if (err) return callback(err);

        let options = {
          bib,
          csl
        };

        convert(blog, text, options, function (err, html) {
          if (err) return callback(err);

          if (Object.keys(parsed.metadata).length > 0) {
            html = '---\n' + yaml.stringify(parsed.metadata) + '---\n' + html;
          }

          callback(null, html, stat);
        });
      });
    });
  });
}

module.exports = { read: read, is: is, id: "markdown"};
