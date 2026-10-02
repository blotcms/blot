const database = require("../database");
const sync = require("./sync");

module.exports = async (blogID, publish, update, options = {}) => {
  publish = publish || function () {};
  update = update || function () {};

  const account = await database.blog.get(blogID);
  const { reset, pruneVerifiedContents } = database.folder(account.folderId, blogID);

  // reset the database state of the folder
  await reset({ preserveVerifiedContent: true });

  // sync() keeps its boolean-only return contract for its other callers;
  // the summary is instead filled in via this out-parameter so the
  // dashboard's manual resync route (the caller of resetFromDrive) can tell
  // whether the resync found changes worth reporting as unsynced.
  const summary = {
    downloaded: 0,
    removed: 0,
    createdDirs: 0,
    modifiedDuringWalk: 0,
  };

  const succeeded = await sync(blogID, publish, update, {
    since: options.since,
    summary,
  });

  if (succeeded) await pruneVerifiedContents();

  return summary;
};
