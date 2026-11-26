const folder = require("storage/folder");
const File = require("models/file");
const contentVersion = require("helper/contentVersion");
const BLOT_CDN_TOKEN = require("./cdnToken");
const { folderCdnPath } = require("./shared");

// Build-time helpers for turning a file in a blog's folder into a versioned
// CDN URL, shared by the entry plugin (app/build/plugins/folderAssets) and
// the template CDN manifest (app/models/template/util/updateCdnManifest).

// Returns { path, version } for a file in the blog folder, or null if it
// doesn't exist. path is the case-corrected path.
//
// The version token is a hash of the file's content (helper/contentVersion),
// not its mtime/ctime. It comes from the folder index's record of the file,
// whose SHA-1 is the content hash, so the file isn't read; only a record
// without one (an index rebuilt without hashing) has the file read and
// hashed, as contentVersion.fromFolder does.
async function hashFolderFile(blogID, path) {
  let record, resolvedPath;

  // One read of the index gives the size, modified time and SHA-1, and never
  // reads the file (folder.stat with { sha1: true } would, to fill in a SHA-1
  // an index rebuilt without hashing left out, even for a file over the cap
  // where the token needs none). Another case is looked for only when the
  // exact path has no record.
  try {
    record = await File.get(blogID, path);
    resolvedPath = path;

    if (!record) {
      resolvedPath = await folder.resolveCaseInsensitive(blogID, path);
      record = await File.get(blogID, resolvedPath);
    }
  } catch (err) {
    return null;
  }

  if (!record) return null;

  const version =
    contentVersion.fromFolderRecord(record) ||
    (await contentVersion.fromFolder(blogID, resolvedPath, record));

  return { path: resolvedPath, version };
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
  return BLOT_CDN_TOKEN + folderCdnPath(blogID, version, path) + (suffix || "");
}

// The version baked for an image that isn't in the folder yet (see
// app/build/plugins/folderAssets): the CDN route serves whatever file is at
// the path, so the URL starts working once the image syncs, and the rebuild
// that follows bakes its content version instead. A different URL from the
// file's own, so a cached 404 for the pending one never hides it.
const PENDING_VERSION = "pending";

module.exports = { hashFolderFile, getStat, folderUrl, PENDING_VERSION };
