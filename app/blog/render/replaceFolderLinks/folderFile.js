const folder = require("storage/folder");
const contentVersion = require("helper/contentVersion");
const BLOT_CDN_TOKEN = require("./cdnToken");
const { encodeFolderPath } = require("./shared");

// Build-time helpers for turning a file in a blog's folder into a versioned
// CDN URL, shared by the entry plugin (app/build/plugins/folderAssets) and
// the template CDN manifest (app/models/template/util/updateCdnManifest).

// Returns { path, version } for a file in the blog folder, or null if it
// doesn't exist. path is the case-corrected path.
//
// The version token is a hash of the file's content (helper/contentVersion),
// not its mtime/ctime: blog folders are moving from local disk to S3, which
// can't set a file's Last-Modified and has no ctime, but does hand back a
// content-derived ETag for free on every PUT. Until storage reads switch
// over, local disk pays the cost of hashing on each build (contentVersion
// falls back to a size+mtime token above its size cap instead).
async function hashFolderFile(blogID, path) {
  let stat, resolvedPath;

  try {
    ({ stat, path: resolvedPath } = await getStat(blogID, path));
  } catch (err) {
    return null;
  }

  return {
    path: resolvedPath,
    version: await contentVersion.fromFolder(blogID, resolvedPath, stat),
  };
}

async function getStat(blogID, path) {
  try {
    const stat = await folder.stat(blogID, path);
    return { stat, path };
  } catch (e) {}

  const resolvedPath = await folder.resolveCaseInsensitive(blogID, path);
  const stat = await folder.stat(blogID, resolvedPath);
  return { stat, path: resolvedPath };
}

// path is the decoded path on disk, percent-encoded here (see
// encodeFolderPath). suffix is any ?query and/or #hash to keep on the end of
// the URL, as written in the link.
function folderUrl(blogID, path, version, suffix) {
  return `${BLOT_CDN_TOKEN}/folder/v-${version}/${blogID}${encodeFolderPath(path)}${suffix || ""}`;
}

// The version baked for an image that isn't in the folder yet (see
// app/build/plugins/folderAssets): the CDN route serves whatever file is at
// the path, so the URL starts working once the image syncs, and the rebuild
// that follows bakes its content version instead. A different URL from the
// file's own, so a cached 404 for the pending one never hides it.
const PENDING_VERSION = "pending";

module.exports = { hashFolderFile, getStat, folderUrl, PENDING_VERSION };
