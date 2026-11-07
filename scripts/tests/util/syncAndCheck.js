const { eachSeries } = require("./callbacks");
const type = require("helper/type");
const CheckEntry = require("./checkEntry");
const sync = require("sync");
const storage = require("storage/folder");

module.exports = function SyncAndCheck(blogID) {
  return (files, entries, callback) => {
    if (type(files) === "object") files = [files];
    if (type(entries) === "object") entries = [entries];

    sync(blogID, (err, folder, syncDone) => {
      if (err) return callback(err);

      eachSeries(
        files,
        ({ path, content }, next) => {
          storage
            .write(blogID, path, content)
            .then(
              () =>
                folder.update(path).then((result) => next(null, result), next),
              next
            );
        },
        (err) => {
          if (err) return syncDone(err, callback);
          eachSeries(entries, CheckEntry(blogID), (err) => {
            syncDone(err, callback);
          });
        }
      );
    });
  };
};
