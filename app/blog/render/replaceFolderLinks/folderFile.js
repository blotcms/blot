const fs = require("fs-extra");
const { join } = require("path");
const { promisify } = require("util");
const contentVersion = require("helper/contentVersion");
const caseSensitivePath = promisify(require("helper/caseSensitivePath"));
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
async function hashFolderFile(blogFolder, path) {
  let stat, resolvedPath;

  try {
    ({ stat, path: resolvedPath } = await getStat(blogFolder, path));
  } catch (err) {
    return null;
  }

  return {
    path: resolvedPath,
    version: await contentVersion(join(blogFolder, resolvedPath), stat),
  };
}

async function getStat(blogFolder, path) {
  const filePath = join(blogFolder, path);

  try {
    const stat = await fs.stat(filePath);
    return { stat, path };
  } catch (e) {}

  const resolvedPath = await caseSensitivePath(blogFolder, path);
  const resolvedRelativePath = resolvedPath.slice(blogFolder.length);
  const stat = await fs.stat(resolvedPath);
  return { stat, path: resolvedRelativePath };
}

// path is the decoded path on disk, percent-encoded here (see
// encodeFolderPath). suffix is any ?query and/or #hash to keep on the end of
// the URL, as written in the link.
function folderUrl(blogID, path, version, suffix) {
  return `${BLOT_CDN_TOKEN}/folder/v-${version}/${blogID}${encodeFolderPath(path)}${suffix || ""}`;
}

module.exports = { hashFolderFile, getStat, folderUrl };
