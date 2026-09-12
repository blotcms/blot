const { getAll } = require("../../lib/models");
const arrayify = require("helper/arrayify");
const projectEntryFields = require("./helpers/projectEntryFields");
const moment = require("moment");
require("moment-timezone");
const asRetriever = require("../../lib/asRetriever");

async function archives(req, res) {
  const allEntries = await getAll(req.blog.id);

  // dateStamp is always kept, so the year/month grouping below is unaffected.
  projectEntryFields(allEntries, req.retrieve, ["archives"]);

  const years = {};

  for (const x in allEntries) {
    const entry = allEntries[x];

    const date = moment.utc(entry.dateStamp).tz(req.blog.timeZone);

    const year = date.format("YYYY");
    const month = date.format("MMMM");

    // Init an empty data structure
    years[year] = years[year] || {
      year: year,
      total: 0,
      months: {},
    };

    years[year].months[month] = years[year].months[month] || {
      month: month,
      entries: [],
    };

    years[year].months[month].entries.push(entry);
    years[year].total++;
  }

  for (const i in years) {
    for (const j in years[i].months)
      years[i].months[j].s = years[i].months[j].entries.length > 1 ? "s" : "";

    years[i].months = arrayify(years[i].months);
    years[i].s = years[i].total > 1 ? "s" : "";
  }

  return arrayify(years).sort(function (a, b) {
    return parseInt(b.year) - parseInt(a.year);
  });
};

module.exports = asRetriever(archives);
