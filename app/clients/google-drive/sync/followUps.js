const syncOrThrow = require("./syncOrThrow");
const followUpSync = require("clients/util/followUpSync");

// The one follow-up queue for Google Drive syncs, shared by everything that
// starts one on a change (the webhook, changes.list, the search): syncs a
// blog now, or leaves a follow-up for any process to run once a sync already
// running (here or in another container) has finished.
module.exports = followUpSync("google-drive", (blogID) => syncOrThrow(blogID));
