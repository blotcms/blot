const { getPage } = require("models/entries");
const projectEntryFields = require("./helpers/projectEntryFields");

module.exports = function (req, res, callback) {
  req.log("Loading latest entry");
  getPage(req.blog.id, { pageNumber: 1, pageSize: 1 }, function (err, entries) {
    req.log("Loaded latest entry");
    const latestEntry = entries && entries.length ? entries[0] : {};
    return callback(
      null,
      projectEntryFields(latestEntry, req.retrieve, [
        "latestEntry",
        "latest_entry",
      ])
    );
  });
};
