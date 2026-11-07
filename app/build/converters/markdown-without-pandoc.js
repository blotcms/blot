// This is used when people are running the server
// locally on a machine without pandoc – it's useful
// for developers who want to contribute
const folder = require("storage/folder");
const { marked } = require("marked");
const extname = require("path").extname;
const cheerio = require("cheerio");
const {
  normalizeLiteralDollarMath,
} = require("build/math/normalizeLiteralDollars");
const postSourceSize = require("build/converters/post-source-size");
const folderStat = require("build/converters/folderStat");

async function read(blog, path) {
  const stat = await folderStat(blog.id, path);

  if (stat.size > postSourceSize.MARKDOWN.bytes)
    throw postSourceSize.tooLargeError(postSourceSize.MARKDOWN);

  const buffer = await folder.read(blog.id, path);
  const text = buffer.toString("utf-8");
  const $ = cheerio.load(marked.parse(text), { decodeEntities: false }, false);
  normalizeLiteralDollarMath($);

  return [$.html(), stat];
}

module.exports = {
  read: read,
  is: function is(path) {
    return (
      [".txt", ".text", ".md", ".markdown"].indexOf(
        extname(path).toLowerCase()
      ) > -1
    );
  },
  id: "markdown",
};
