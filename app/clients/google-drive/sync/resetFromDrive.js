const database = require("../database");
const health = require("clients/health");
const { classify } = require("../database/error");
const sync = require("./sync");

// Thrown instead of resolving when there is no folder to resync from, so the
// dashboard's "Resync from Google Drive" action can tell the user to choose a
// new folder rather than reporting a successful rebuild (see
// app/dashboard/site/client.js).
const FOLDER_MISSING = "GOOGLE_DRIVE_FOLDER_MISSING";

function folderMissingError(account) {
  const error = new Error(
    (account && account.error) ||
      "This site is not connected to a Google Drive folder. Please select a new folder to continue syncing."
  );
  error.code = FOLDER_MISSING;
  return error;
}

module.exports = async (blogID, publish, update) => {
  publish = publish || function () {};
  update = update || function () {};

  const account = await database.blog.get(blogID);

  // sync() nulls folderId when it finds the folder trashed, deleted or
  // unshared, so there is nothing to walk until the user sets up again.
  if (!account || !account.folderId) throw folderMissingError(account);

  const { pruneVerifiedContents } = database.folder(account.folderId, blogID);

  // sync resets the database state of the folder once it has confirmed
  // the folder is still reachable
  const summary = await sync(blogID, publish, update, { reset: true });

  if (summary) {
    await pruneVerifiedContents();
    return summary;
  }

  // The folder lookup at the start of this resync may have just found it gone
  const latest = await database.blog.get(blogID);
  if (classify(latest) === health.CODES.SOURCE_MISSING) {
    throw folderMissingError(latest);
  }

  return summary;
};

module.exports.FOLDER_MISSING = FOLDER_MISSING;
