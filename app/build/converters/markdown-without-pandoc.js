// This is used when people are running the server
// locally on a machine without pandoc – it's useful
// for developers who want to contribute
const folder = require("storage/folder");
const { callbackify } = require("util");
const { marked } = require("marked");
const extname = require("path").extname;
const cheerio = require("cheerio");
const { normalizeLiteralDollarMath } = require("build/math/normalizeLiteralDollars");
const postSourceSize = require("build/converters/post-source-size");
const folderStat = callbackify(require("build/converters/folderStat"));
const readFile = callbackify(folder.read);

module.exports = {
  read: function (blog, path, callback) {
    folderStat(blog.id, path, function (err, stat) {
      if (err) return callback(err);
      if (stat.size > postSourceSize.MARKDOWN.bytes)
        return callback(postSourceSize.tooLargeError(postSourceSize.MARKDOWN));

      readFile(blog.id, path, function (err, buffer) {
        if (err) return callback(err);

        const text = buffer.toString("utf-8");
        const $ = cheerio.load(
          marked.parse(text),
          { decodeEntities: false },
          false
        );
        normalizeLiteralDollarMath($);

        callback(null, $.html(), stat);
      });
    });
  },
  is: function is (path) {
    return (
      [".txt", ".text", ".md", ".markdown"].indexOf(
        extname(path).toLowerCase()
      ) > -1
    );
  },
  id: "markdown"
};
