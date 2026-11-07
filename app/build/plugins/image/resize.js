var debug = require("debug")("blot:entry:build:plugins:images");
var sandbox = require("sandbox");
var ensure = require("helper/ensure");
var tempDir = require("helper/tempDir")();
var fs = require("fs-extra");
var { v4: uuid } = require("uuid");
var extname = require("path").extname;

// We don't do .gif because sharp cannot handle animated
// gifs at the moment. Perhaps in future...
var RESIZE_EXTENSION_WHITELIST = [".jpg", ".jpeg", ".png"];

async function resize(path) {
  ensure(path, "string");

  var output = tempDir + uuid();
  var extension = extname(path).toLowerCase();

  // Since this image is not one we can resize, we fetch
  // its dimensions and continue...
  if (RESIZE_EXTENSION_WHITELIST.indexOf(extension) === -1) {
    debug("Fetching metadata for", path);
    const metadata = await sandbox.run("metadata", {}, { path: path });
    return metadata.meta;
  }

  debug("Resizing", path);

  // The sandbox does the sharp work (app/sandbox/jobs/resize.js) and the
  // resized file is written to a temporary file here and moved over the original
  const result = await sandbox.run("resize", { max: 3000 }, { path: path });
  var info = result.meta;

  if (!info || !result.outputs.length) throw "No info";

  await fs.writeFile(output, result.outputs[0]);

  // Remove the unresized file
  await fs.remove(path);

  // Move the resized file
  await fs.move(output, path);

  return info;
}

const promiseOnly = require("helper/promiseOnly");

module.exports = promiseOnly(resize);
