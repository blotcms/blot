var Entries = require("models/entries");
var projectEntryFields = require("./helpers/projectEntryFields");
var entryFieldList = require("./helpers/entryFieldList");
var withEntryFields = require("./helpers/withEntryFields");

module.exports = function (req, res, callback) {
  var keys = ["allEntries", "all_entries"];
  var fields = entryFieldList(req.retrieve, keys);

  var done = function (allEntries) {
    return callback(null, projectEntryFields(allEntries, req.retrieve, keys));
  };

  if (!fields) return Entries.getAll(req.blog.id, done);

  withEntryFields(
    function (cb) {
      Entries.getAll(req.blog.id, { fields: fields }, cb);
    },
    function (cb) {
      Entries.getAll(req.blog.id, cb);
    },
    done
  );
};
