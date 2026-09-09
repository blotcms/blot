var Entries = require("models/entries");
var arrayify = require("helper/arrayify");
var projectEntryFields = require("./helpers/projectEntryFields");
var moment = require("moment");
require("moment-timezone");

module.exports = function (req, res, callback) {
  Entries.getAll(req.blog.id, function (allEntries) {
    // dateStamp is always kept, so the year/month grouping below is unaffected.
    projectEntryFields(allEntries, req.retrieve, ["archives"]);

    var years = {};

    for (var x in allEntries) {
      var entry = allEntries[x];

      var date = moment.utc(entry.dateStamp).tz(req.blog.timeZone);

      var year = date.format("YYYY");
      var month = date.format("MMMM");

      // Init an empty data structure
      years[year] = years[year] || {
        year: year,
        total: 0,
        months: {}
      };

      years[year].months[month] = years[year].months[month] || {
        month: month,
        entries: []
      };

      years[year].months[month].entries.push(entry);
      years[year].total++;
    }

    for (var i in years) {
      for (var j in years[i].months)
        years[i].months[j].s = years[i].months[j].entries.length > 1 ? "s" : "";

      years[i].months = arrayify(years[i].months);
      years[i].s = years[i].total > 1 ? "s" : "";
    }

    years = arrayify(years).sort(function (a, b) {
      return parseInt(b.year) - parseInt(a.year);
    });

    return callback(null, years);
  });
};
