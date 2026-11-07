var fs = require("fs");
var bplist = require("bplist-parser");
var ensure = require("helper/ensure");
var titlify = require("build/prepare/titlify");
var withLocal = require("build/converters/folderStat").withLocal;
var promiseOnly = require("helper/promiseOnly");
var extname = require("path").extname;

var INVALID = "Invalid webloc file";

function is(path) {
  return (
    extname(path).toLowerCase() === ".webloc" ||
    extname(path).toLowerCase() === ".url"
  );
}

async function extract(localPath) {
  // First we attempt to parse the file as if it
  // were XML. This is the format used by Chrome and Firefox.
  // If this fails, we then try to parse the file
  // as if it were a Binary Plist file which is
  // the format used by Safari, and then as a .url file.
  for (const extractor of [extractFromXML, extractFromBPlist, extractFromURL]) {
    try {
      const url = await extractor(localPath);

      if (url) return url;
    } catch (err) {
      // Not this format: try the next
    }
  }

  throw new Error(INVALID);
}

async function extractFromURL(localPath) {
  const contents = await fs.promises.readFile(localPath, "utf-8");

  if (
    contents.indexOf("[InternetShortcut]") === -1 ||
    contents.indexOf("URL=") === -1
  )
    return;

  return contents.slice(contents.indexOf("URL=") + "URL=".length).trim();
}

async function extractFromXML(localPath) {
  var reg = /<string>(.*)<\/string>/g;

  const contents = await fs.promises.readFile(localPath, "utf-8");

  return reg.exec(contents)[1];
}

async function extractFromBPlist(localPath) {
  // bplist-parser's parseFile returns a promise that rejects on a bad file
  const obj = await bplist.parseFile(localPath);

  return obj[0].URL;
}

async function read(blog, path) {
  ensure(blog, "object").and(path, "string");

  const file = await withLocal(blog.id, path);

  const stat = file.stat;

  const url = await extract(file.localPath);

  if (!url) throw new Error(INVALID);

  const contents =
    '<p><a href="' + url + '" class="bookmark">' + titlify(path) + "</a></p>";

  return [contents, stat];
}

// Called back with (err, html, stat); without a callback it resolves to
// [html, stat]
module.exports = { is: is, read: promiseOnly(read), id: "webloc" };
