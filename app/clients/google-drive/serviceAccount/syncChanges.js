const { dirname } = require("path").posix;
const clfdate = require("helper/clfdate");
const database = require("../database");
const followUps = require("../sync/followUps");
const hotDocPoller = require("./hotDocPoller");
const { logChanges } = require("./readChanges");

const DOCUMENT = "application/vnd.google-apps.document";

const prefix = () => `${clfdate()} Google Drive changes:`;

// Logs a failure of work this doesn't wait for
async function logFailure(promise, ...context) {
  try {
    await promise;
  } catch (error) {
    console.error(prefix(), ...context, error.message);
  }
}

// The Drive directories of the blog to list again for one change: the one the
// file was in (from the blog's folder mapping), so a rename, trash or move
// out is applied, and the one it is in now, so a new file or a move in is.
// A change to the blog's own folder lists it again: Drive records one each
// time something is added at the top, and a rename or trash of the folder is
// caught by the check every sync starts with. A mapped file whose directory
// the mapping has lost asks for a full walk.
async function dirtyDirectories({ change, blogID, folderId, path, parentId }) {
  if (change.fileId === folderId) return [folderId];

  const ids = [];
  if (path) {
    const id = await database.folder(folderId, blogID).getByPath(dirname(path));
    ids.push(id || database.dirty.FULL);
  }
  if (parentId) ids.push(parentId);
  return ids;
}

// Syncs the blogs a batch of changes belongs to (placed, from readChanges'
// placeChanges). Used for changes.list and for the search (#2847), beside the
// changes.watch webhook, which still syncs every blog on the account.
//
// Each blog's follow-up is written to Redis (arm) before this resolves, and
// the caller moves its page token on only after that, so a change can't be
// lost if this process dies before its sync has run. The syncs themselves
// aren't awaited: a long sync of one blog mustn't hold up reading changes for
// the others. A blog already syncing gets one more sync once it has finished
// (followUpSync), which is how a change the running walk had already passed
// is picked up.
//
// A changed Google Doc is also handed to the hot doc poller: edits to an open
// Doc don't reach Drive's metadata for about 2 minutes, and only
// docs.documents.get sees them, so the poller has to be watching it.
module.exports = async function syncChanges(
  serviceAccountId,
  placed,
  source = "changes"
) {
  logChanges(serviceAccountId, placed, source);

  const blogs = new Map();
  const dirty = new Map();
  for (const entry of placed) {
    const { change, blogID, folderId } = entry;
    if (!blogID) continue;
    blogs.set(blogID, (blogs.get(blogID) || 0) + 1);
    if (!dirty.has(blogID)) dirty.set(blogID, new Set());
    for (const id of await dirtyDirectories(entry)) dirty.get(blogID).add(id);

    if (change.file?.mimeType === DOCUMENT && !change.file?.trashed) {
      logFailure(
        hotDocPoller.enqueue({
          blogID,
          serviceAccountId,
          fileId: change.fileId,
          folderId,
        }),
        "hot doc enqueue failed"
      );
    }
  }

  // Recorded before the syncs start, so the sync that runs finds them
  for (const [blogID, ids] of dirty) {
    await database.dirty.add(blogID, [...ids]);
  }

  const armed = new Map();
  for (const blogID of blogs.keys()) {
    armed.set(blogID, await followUps.arm(blogID));
  }

  for (const [blogID, count] of blogs) {
    console.log(
      prefix(),
      `client_id=${serviceAccountId} source=${source} syncing blog=${blogID} changes=${count}`
    );
    logFailure(followUps.run(blogID, armed.get(blogID)), "sync failed", blogID);
  }
};
