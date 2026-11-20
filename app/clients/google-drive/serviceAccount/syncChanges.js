const clfdate = require("helper/clfdate");
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
  for (const { change, blogID, folderId } of placed) {
    if (!blogID) continue;
    blogs.set(blogID, (blogs.get(blogID) || 0) + 1);

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
