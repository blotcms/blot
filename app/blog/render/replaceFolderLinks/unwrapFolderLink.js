const BLOT_CDN_TOKEN = require("./cdnToken");

const PREFIX = BLOT_CDN_TOKEN + "/folder/";

// Reverses the link app/build/plugins/folderAssets bakes into entry HTML:
//   %%BLOT_CDN%%/folder/v-<hash>/<blogID><path>[?query][#hash]
// back to "<path>[?query][#hash]". Returns null if the value isn't a
// baked link for this blog.
module.exports = function unwrapFolderLink(value, blogID) {
  if (!blogID || typeof value !== "string" || value.indexOf(PREFIX) !== 0) {
    return null;
  }

  const rest = value.slice(PREFIX.length);
  const versionEnd = rest.indexOf("/");

  if (versionEnd === -1) return null;

  const afterVersion = rest.slice(versionEnd + 1);

  if (afterVersion.indexOf(blogID + "/") !== 0) return null;

  return afterVersion.slice(blogID.length);
};
