var Entries = require("models/entries");
var projectEntryFields = require("./helpers/projectEntryFields");
var entryFieldList = require("./helpers/entryFieldList");
var withEntryFields = require("./helpers/withEntryFields");

module.exports = function (req, res, callback) {
  var keys = ["recentEntries", "recent_entries"];
  var fields = entryFieldList(req.retrieve, keys);

  var done = function (recentEntries) {
    return callback(null, projectEntryFields(recentEntries, req.retrieve, keys));
  };

  if (!fields) return Entries.getRecent(req.blog.id, done);

  withEntryFields(
    function (cb) {
      Entries.getRecent(req.blog.id, { fields: fields }, cb);
    },
    function (cb) {
      Entries.getRecent(req.blog.id, cb);
    },
    done
  );
};
