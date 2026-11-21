const database = require("./database");

// Deletes everything Blot keeps in Redis for a blog's Google Drive
// connection: the account record and its place in the account sets, the
// folder's id <-> path mapping and checksums, and the directories waiting to
// be synced. Nothing in Drive is touched. Safe to call for a blog with no
// Drive connection, and to call again.
//
// Blog.remove calls this for every deleted blog, whatever its client is now:
// a record can outlive the connection (a disconnect that failed part way, a
// blog that moved to another client), and it then holds the person's folder
// against connecting it again and makes every start try to resume its setup.
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
