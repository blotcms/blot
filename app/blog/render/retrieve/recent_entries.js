var Entries = require("models/entries");
var projectEntryFields = require("./helpers/projectEntryFields");

module.exports = function (req, res, callback) {
  Entries.getRecent(req.blog.id, function (recentEntries) {
    return callback(
      null,
      projectEntryFields(recentEntries, req.retrieve, [
        "recentEntries",
        "recent_entries",
      ])
    );
  });
};
