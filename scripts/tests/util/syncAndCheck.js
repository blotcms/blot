const { eachSeries } = require("./callbacks");
const type = require("helper/type");
const CheckEntry = require("./checkEntry");
const sync = require("sync");
const storage = require("storage/folder");

module.exports = function SyncAndCheck(blogID) {
  return (files, entries, callback) => {
    if (type(files) === "object") files = [files];
    if (type(entries) === "object") entries = [entries];

    // The entries are checked once the sync has finished, so that what
    // depends on the files has been rebuilt (sync/update/dependents.js)
    sync(blogID, async (folder) => {
      for (const { path, content } of files) {
        await storage.write(blogID, path, content);
        await folder.update(path);
      }
    })
      .then(
        () =>
          new Promise((resolve, reject) => {
            eachSeries(entries, CheckEntry(blogID), (err) => {
              if (err) return reject(err);
              resolve();
            });
          })
      )
      .then(() => callback(null), callback);
  };
};
