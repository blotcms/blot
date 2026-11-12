const storage = require("storage/folder");
const clfdate = require("helper/clfdate");

// A blog's placeholders: the empty files a sync client wrote where it could
// not download a file (storage/folder's writePlaceholder). Their bytes are
// only reachable through the client which wrote them, so they go when the
// blog disconnects from it.

// Every placeholder in the folder, as [{ path, flags }]. It reads the whole
// index, so it is for the disconnect page, not for every request.
async function list(blogID) {
  const found = [];

  for await (const file of storage.flagged(blogID)) {
    if (file.placeholder) found.push({ path: file.path, flags: file.flags });
  }

  return found;
}

// Removes every placeholder. folder is the sync's folder (sync's
// establishSyncLock or Sync), so each removal is synced like any other.
// Resolves to the paths removed.
async function remove(blogID, folder) {
  const removed = [];

  for (const { path } of await list(blogID)) {
    // Something may have replaced it since the listing
    if (!(await storage.isPlaceholder(blogID, path))) continue;

    folder.status("Removing placeholder " + path);
    await storage.remove(blogID, path);
    await folder.update(path);
    removed.push(path);
  }

  return removed;
}

// For a client's disconnect: removes the placeholders under the blog's sync
// lock (Sync, required here so loading this module doesn't load sync), or,
// given folder, within the sync already running. Best effort: a failure
// (another sync holds the lock, the blog is disabled or being deleted) is
// logged and never fails the disconnect, and a placeholder left behind keeps
// its flag.
async function removeAtDisconnect(blogID, folder) {
  try {
    if (folder) return await remove(blogID, folder);

    return await require("sync")(blogID, (folder) => remove(blogID, folder));
  } catch (err) {
    console.error(
      clfdate(),
      "Could not remove placeholders at disconnect",
      blogID,
      err && err.message
    );
    return [];
  }
}

module.exports = { list, remove, removeAtDisconnect };
