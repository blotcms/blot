var Transformer = require("helper/transformer");
var assets = require("storage/assets");
var Transform = require("./transform");
var Create = require("./create");
var debug = require("debug")("blot:entry:build:thumbnail:seed");

// Must match the store thumbnail() reads (./index.js)
var STORE_PREFIX = "thumbnails";

// What the image plugin asks the resize job for, along with the resized image,
// when that image is the post's first candidate: the thumbnail job's own
// arguments for it. The job makes the thumbnails from the bytes it has just
// encoded, the very bytes thumbnail() would hand the thumbnail job, so they are
// the same thumbnails. Images are never animated here: the resize job only
// takes JPEG and PNG.
function args(path) {
  return Transform.request(Transform.outputExtension(path), false);
}

// Stores the thumbnails the resize job made, as thumbnail() would have, under
// the hash of the file they were made from (the resized image, as it is in the
// blog's generated assets), so its lookup finds them and runs no job of its
// own. An image the job refused (too small...) is stored as the rejection
// thumbnail() stores for one.
async function seed(blogID, fileHash, path, reply) {
  var outputDirectory = Create.directoryForHash(fileHash);
  var extension = Transform.outputExtension(path);
  var result;

  try {
    result = await Transform.write(
      reply,
      extension,
      assets.path(blogID, outputDirectory)
    );
  } catch (err) {
    if (!err || !err.invalid) throw err;
    result = { rejected: err.message };
  }

  if (result.rejected === undefined)
    await Create.publish(blogID, outputDirectory, result);

  await new Transformer(blogID, STORE_PREFIX).set(fileHash, result);

  debug(blogID, "seeded", fileHash);
}

module.exports = { args: args, seed: seed };
