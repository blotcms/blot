const Entries = require("models/entries");
const Entry = require("models/entry");
const withCallback = require("helper/withCallback");
const moment = require("moment");

const NUMBER_OF_SCHEDULED_ENTRIES_TO_DISPLAY = 5;

module.exports = function (req, res, next) {
  const blogID = req.blog.id;
  const options = { start: 0, end: NUMBER_OF_SCHEDULED_ENTRIES_TO_DISPLAY + 1 };

  Entries.getListIDs(blogID, "scheduled", options, function (err, ids) {
    if (err) {
      console.log(err);
      return next();
    }

    // A failed read is the same as no entries
    withCallback(Entry.get)(blogID, ids, function (getErr, entries) {
      entries = entries || [];

      if (err) {
        console.log(err);
        return next();
      }

      res.locals.more_scheduled_entries =
        entries.length > NUMBER_OF_SCHEDULED_ENTRIES_TO_DISPLAY;

      res.locals.scheduled = entries
        .slice(0, NUMBER_OF_SCHEDULED_ENTRIES_TO_DISPLAY)
        .map(function (entry) {
          return {
            title: entry.title,
            date: moment(entry.dateStamp).fromNow(),
            path: entry.path,
          };
        });

      next();
    });
  });
};
