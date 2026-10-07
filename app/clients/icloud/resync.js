const database = require("./database");
const syncFromiCloud = require("./sync/fromiCloud");
const health = require("../health");
const { classify } = require("./error");

// Thrown instead of resolving when a resync would do harm or can't work, so
// the dashboard's "Resync from iCloud" action reports the refusal rather
// than "Finished site rebuild" (see RESYNC_REFUSALS in
// app/dashboard/site/client.js).
const FOLDER_MISSING = "ICLOUD_FOLDER_MISSING";
const SETUP_INCOMPLETE = "ICLOUD_SETUP_INCOMPLETE";

function refusal(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

module.exports = async (blogID, publish, update) => {
  const account = await database.get(blogID);

  // The watcher saw the shared folder deleted. Walking it would only fail
  // at the first readdir, so say what to do instead.
  if (classify(account) === health.CODES.SOURCE_MISSING) {
    throw refusal(
      FOLDER_MISSING,
      "The iCloud folder used to sync this site was deleted. Please share a new folder to continue syncing."
    );
  }

  // Resyncing makes iCloud the source of truth: local files iCloud doesn't
  // have are removed. Until setup and the initial transfer have finished,
  // that includes Blot's own files which haven't reached iCloud yet.
  if (!account || account.setupComplete !== true) {
    throw refusal(
      SETUP_INCOMPLETE,
      "This site's files haven't finished transferring to iCloud, so Blot can't resync from it yet. Please set up your iCloud folder again."
    );
  }

  return syncFromiCloud(blogID, publish, update);
};

module.exports.FOLDER_MISSING = FOLDER_MISSING;
module.exports.SETUP_INCOMPLETE = SETUP_INCOMPLETE;
