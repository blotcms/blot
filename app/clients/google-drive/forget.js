const database = require("./database");
const hashes = require("./util/hashes");

// Deletes everything Blot keeps in Redis for a blog's Google Drive
// connection: the account record and its place in the account sets, the
// folder's id <-> path mapping and checksums, and the directories waiting to
// be synced. Nothing in Drive is touched. Safe to call for a blog with no
// Drive connection, and to call again.
//
// Used by disconnect, which Blog.remove calls when a blog connected to
// Google Drive is deleted, so a disconnected blog leaves no Drive data
// behind. A record left by an earlier disconnect is purged by
// scripts/google-drive/purge-dangling-records.js.
//
// The blog's records of its Drive folder: the folder's mapping, and the
// blog's own checksums of its files. The mapping is keyed by the folder
// alone, so it is kept if another blog's account names the same folder.
async function forgetFolder(blogID, folderId) {
  if (!folderId) return;

  let shared = false;
  await database.blog.iterate(async (otherID, other) => {
    if (otherID !== blogID && other.folderId === folderId) shared = true;
  });

  const folder = database.folder(folderId, blogID);
  if (!shared) return folder.reset();
  await folder.forgetOwn();
}

async function forget(blogID) {
  const account = await database.blog.get(blogID);

  // The folder first: the account record is what names it, so a forget that
  // stops between the two can be run again and still finds the folder
  await forgetFolder(blogID, account?.folderId);
  await database.dirty.forget(blogID);
  await hashes.drop(blogID);
  await database.blog.delete(blogID);
}

module.exports = forget;
module.exports.forgetFolder = forgetFolder;
