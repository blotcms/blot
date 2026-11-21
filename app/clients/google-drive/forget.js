const database = require("./database");

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
// The folder's mapping is keyed by the Drive folder alone, so it is kept if
// another blog's account names the same folder.
async function forget(blogID) {
  const account = await database.blog.get(blogID);

  await database.blog.delete(blogID);
  await database.dirty.forget(blogID);

  if (!account?.folderId) return;

  let shared = false;
  await database.blog.iterate(async (otherID, other) => {
    if (otherID !== blogID && other.folderId === account.folderId)
      shared = true;
  });
  if (!shared) await database.folder(account.folderId, blogID).reset();
}

module.exports = forget;
