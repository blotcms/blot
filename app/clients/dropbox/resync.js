// Wraps resetToBlot for the generic "Resync from <client>" dashboard action
// (app/dashboard/site/client.js's POST /reset/resync, which calls
// client.resync(blogID, publish, update) for whichever client the blog
// uses). resetToBlot treats Dropbox as the source of truth and deletes any
// local file with no Dropbox counterpart, so it must never run for a blog
// whose initial transfer to Dropbox hasn't finished - that's exactly the set
// of files that would get wrongly deleted. See transferIncomplete() in
// util/constants.js and its callers (init.js, sync/index.js) for the other
// places this same check gates automatic syncs; this is the one manual path.
//
// Unlike init.js's resetToBlotWithLock, this check doesn't need its own
// re-read-after-acquiring-the-lock dance: app/dashboard/site/client.js's
// POST /reset/resync already acquires this blog's folder lock (via
// `Sync(req.blog.id, ...)`) before ever calling this function, and every
// other Dropbox code path that could change transfer_pending/error_code for
// this blog (reset-from-blot.js via setup, reset-to-blot.js via
// resetToBlotWithLock, the webhook sync in sync/index.js) needs that same
// lock. So by the time we get here the account can't change underneath us.
const { promisify } = require("util");
const database = require("./database");
const resetToBlot = require("./sync/reset-to-blot");
const { transferIncomplete } = require("./util/constants");

const getAccount = promisify(database.get);

module.exports = async function resync(blogID, publish, update) {
  const account = await getAccount(blogID);

  if (transferIncomplete(account)) {
    const message =
      "Blot hasn't finished transferring this folder to Dropbox yet, so it can't be resynced from Dropbox without risking deleting files that were never uploaded. Free up space in Dropbox (if that's the issue) and retry the transfer from the Dropbox settings page, or disconnect, then try again.";

    if (typeof publish === "function") publish(message);

    const error = new Error(message);
    error.code = "DROPBOX_TRANSFER_INCOMPLETE";
    throw error;
  }

  return resetToBlot(blogID, publish, update);
};
