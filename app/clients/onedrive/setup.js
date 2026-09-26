const { promisify } = require("util");
const sync = require("sync");
const graph = require("./util/graph");
const database = require("./database");
const titleToFolder = require("./util/titleToFolder");
const resetFromBlot = require("./sync/reset-from-blot");
const { persistError } = require("./util/persistError");
const { SOURCES } = require("./util/classifyError");

const set = promisify(database.set);

// Runs after the user connects OneDrive: creates a folder for the blog in
// the app folder and uploads the blog's existing files into it, holding the
// folder lock and reporting progress through the sync status. Failures
// are shown in that status; the user can disconnect and try again.
module.exports = function setup(blogID, title, callback) {
  sync(blogID, async function (err, folder, done) {
    if (err) return callback(err);

    try {
      folder.status("Creating folder in OneDrive");

      const root = await graph.getAppRoot(blogID);
      const created = await graph.createFolder(
        blogID,
        root.id,
        titleToFolder(title)
      );

      await set(blogID, {
        folder: created.name,
        folder_id: created.id,
        last_sync: Date.now(),
      });

      folder.status("Syncing your folder to OneDrive");

      await resetFromBlot(blogID, folder.status);
    } catch (err) {
      await persistError(blogID, err, SOURCES.APPLY);
      folder.status("Error: " + err.message);
      return done(err, callback);
    }

    done(null, callback);
  });
};
