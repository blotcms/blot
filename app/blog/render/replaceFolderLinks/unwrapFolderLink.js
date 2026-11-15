const BLOT_CDN_TOKEN = require("./cdnToken");

const OLD_PREFIX = BLOT_CDN_TOKEN + "/folder/";

// Reverses the link app/build/plugins/folderAssets bakes into entry HTML:
//   %%BLOT_CDN%%/<blogID>/folder/v-<hash><path>[?query][#hash]
// or the form baked before #2695, still in posts not rebuilt since:
//   %%BLOT_CDN%%/folder/v-<hash>/<blogID><path>[?query][#hash]
// back to "<path>[?query][#hash]". <path> stays percent-encoded (see
// encodeFolderPath in shared.js), like any other root-relative URL, so a
// '#' or '?' in a file name can't be confused with a fragment or query:
// split those off before decoding it with decodeFolderPath. Returns null if
// the value isn't a baked link for this blog.
module.exports = function unwrapFolderLink(value, blogID) {
  if (!blogID || typeof value !== "string") return null;

  const prefix = BLOT_CDN_TOKEN + "/" + blogID + "/folder/v-";

  if (value.indexOf(prefix) === 0) {
    const rest = value.slice(prefix.length);
    const versionEnd = rest.indexOf("/");
    const path = versionEnd === -1 ? "" : rest.slice(versionEnd);

    // A file is always named after the version: "/" alone is no link
    return path.length > 1 ? path : null;
  }

  if (value.indexOf(OLD_PREFIX) !== 0) return null;

  const rest = value.slice(OLD_PREFIX.length);
  const versionEnd = rest.indexOf("/");

  if (versionEnd === -1) return null;

  const afterVersion = rest.slice(versionEnd + 1);

  if (afterVersion.indexOf(blogID + "/") !== 0) return null;

  return afterVersion.slice(blogID.length);
};
