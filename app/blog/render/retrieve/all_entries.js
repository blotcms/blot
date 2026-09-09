var Entries = require("models/entries");
var projectEntryFields = require("./helpers/projectEntryFields");

module.exports = function (req, res, callback) {
  Entries.getAll(req.blog.id, function (allEntries) {
    return callback(
      null,
      projectEntryFields(allEntries, req.retrieve, ["allEntries", "all_entries"])
    );
  });
};
