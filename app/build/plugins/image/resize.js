var debug = require("debug")("blot:entry:build:plugins:images");
var sandbox = require("sandbox");
var ensure = require("helper/ensure");
var tempDir = require("helper/tempDir")();
var fs = require("fs-extra");
var { v4: uuid } = require("uuid");
var extname = require("path").extname;
var hashBuffer = require("helper/transformer/hash").buffer;

// We don't do .gif because sharp cannot handle animated
// gifs at the moment. Perhaps in future...
var RESIZE_EXTENSION_WHITELIST = [".jpg", ".jpeg", ".png"];

// Resolves to the image's info. With thumbnails, the arguments of the
// sandbox's thumbnail job (build/thumbnail/seed.js), the resize job also makes
// the thumbnails of the image it writes, and this resolves to
//
//   { info, thumbnail, hash }
//
// where thumbnail is { meta, outputs } as the thumbnail job answers, or null if
// the job didn't make them, and hash is the hash of the resized file's bytes.
async function resize(path, thumbnails) {
  ensure(path, "string");

  var output = tempDir + uuid();
  var extension = extname(path).toLowerCase();
  var withThumbnails = thumbnails !== undefined;

  // Since this image is not one we can resize, we fetch
  // its dimensions and continue...
  if (RESIZE_EXTENSION_WHITELIST.indexOf(extension) === -1) {
    debug("Fetching metadata for", path);
    const metadata = await sandbox.run("metadata", {}, { path: path });
    return withThumbnails
      ? { info: metadata.meta, thumbnail: null, hash: null }
      : metadata.meta;
  }

  debug("Resizing", path);

  // The sandbox does the sharp work (app/sandbox/jobs/resize.js) and the
  // resized file is written to a temporary file here and moved over the original
  const args = { max: 3000 };
  if (withThumbnails) args.thumbnail = thumbnails;

  const result = await sandbox.run("resize", args, { path: path });
  var info = result.meta;

  if (!info || !result.outputs.length) throw "No info";

  var thumbnail = null;

  // Not part of the image's info, which is stored as the image's result
  if (info.thumbnail) {
    thumbnail = { meta: info.thumbnail, outputs: result.outputs.slice(1) };
    info = Object.assign({}, info);
    delete info.thumbnail;
  }

  await fs.writeFile(output, result.outputs[0]);

  // Remove the unresized file
  await fs.remove(path);

  // Move the resized file
  await fs.move(output, path);

  return withThumbnails
    ? { info: info, thumbnail: thumbnail, hash: hashBuffer(result.outputs[0]) }
    : info;
}

module.exports = resize;
