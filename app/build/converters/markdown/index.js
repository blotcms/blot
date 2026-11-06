var folder = require("storage/folder");
var ensure = require("helper/ensure");
var time = require("helper/time");
var extname = require("path").extname;

var layout = require("./layout");
var convert = require("./convert");
var extractMetadata = require("build/metadata");
var yaml = require("yaml");
var extractBibAndCSL = require("./extractBibAndCSL");
var linebreaks = require("./linebreaks");
var postSourceSize = require("build/converters/post-source-size");
var folderStat = require("build/converters/folderStat");
var withResults = require("build/withResults");

function is(path) {
  return (
    [".txt", ".text", ".md", ".markdown"].indexOf(extname(path).toLowerCase()) >
    -1
  );
}

async function read(blog, path) {
  ensure(blog, "object").and(path, "string");

  time("stat");

  var stat;

  try {
    stat = await folderStat(blog.id, path);
  } finally {
    time.end("stat");
  }

  if (stat.size > postSourceSize.MARKDOWN.bytes)
    throw postSourceSize.tooLargeError(postSourceSize.MARKDOWN);

  time("readFile");

  var buffer;

  try {
    buffer = await folder.read(blog.id, path);
  } finally {
    time.end("readFile");
  }

  var text = buffer.toString("utf-8");

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

  const [bib, csl] = await extractBibAndCSL(blog, path, parsed.metadata);

  let options = {
    bib,
    csl,
  };

  let html = await convert(blog, text, options);

  if (Object.keys(parsed.metadata).length > 0) {
    html = "---\n" + yaml.stringify(parsed.metadata) + "---\n" + html;
  }

  return [html, stat];
}

// Called back with (err, html, stat); without a callback it resolves to
// [html, stat]
module.exports = { read: withResults(read), is: is, id: "markdown" };
