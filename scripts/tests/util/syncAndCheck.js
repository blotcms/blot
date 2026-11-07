const { eachSeries } = require("./callbacks");
const type = require("helper/type");
const CheckEntry = require("./checkEntry");
const sync = require("sync");
const storage = require("storage/folder");

module.exports = function SyncAndCheck(blogID) {
  return (files, entries, callback) => {
    if (type(files) === "object") files = [files];
    if (type(entries) === "object") entries = [entries];

    // The entries are checked before the sync finishes
    sync(blogID, async (folder) => {
      for (const { path, content } of files) {
        await storage.write(blogID, path, content);
        await folder.update(path);
      }

      await new Promise((resolve, reject) => {
        eachSeries(entries, CheckEntry(blogID), (err) => {
          if (err) return reject(err);
          resolve();
        });
      });
    }).then(() => callback(null), callback);
  };
};
