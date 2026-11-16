var extname = require("path").extname;
var hash = require("helper/hash");
var assets = require("storage/assets");
var clfdate = require("helper/clfdate");
var { removePointingAt } = require("storage/sweep/assetsCache");

// The extensions of the files whose converters write what they extract to
// {blogID}/_assets/<md5 of the file's path>/: documents (build/converters/docx,
// odt, rtf and gdoc, the last also what the Google Drive import writes images
// for) and the images img converts to PNG. The converters hash the path the
// sync gave them, which is the normalised path of the file in the blog's
// folder (helper/pathNormalizer: leading slash, as stored, NFC).
var EXTENSIONS = [
  ".docx",
  ".odt",
  ".rtf",
  ".gdoc",
  ".tif",
  ".tiff",
  ".webp",
  ".avif",
  ".heic",
  ".heif",
];

function hasConvertedAssets(path) {
  return EXTENSIONS.includes(extname(path).toLowerCase());
}

// A reconversion of a path overwrites the same directory, but a file which is
// removed or renamed leaves its directory behind, and nothing else points at
// it: the derived files may go with their source. Called once the file's
// entry has been dropped. A failure is logged and never thrown: the sync
// goes on, and scripts/storage/assets-of-removed-files.js deletes any
// directory this missed. The CDN's copies aren't purged here: the Perma-Cache
// sweep purges the generated files which have left the bucket.
async function removeConvertedAssets(blogID, path) {
  if (!hasConvertedAssets(path)) return;

  try {
    var directory = hash(path);

    // First the transformer's cached results which name the directory, so a
    // build after this converts again rather than linking what's gone
    await removePointingAt(blogID, new Set([directory]));

    // A hash is fixed-length, so "_assets/<hash>" is no other directory's prefix
    await assets.remove(blogID, "_assets/" + directory);
  } catch (err) {
    console.error(clfdate(), blogID, path, "Error removing _assets", err);
  }
}

module.exports = removeConvertedAssets;
module.exports.hasConvertedAssets = hasConvertedAssets;
