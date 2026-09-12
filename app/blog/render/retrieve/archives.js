const { getEntry } = require("../../lib/models");
const arrayify = require("helper/arrayify");
const projectEntryFields = require("./helpers/projectEntryFields");
const entryFieldList = require("./helpers/entryFieldList");
const withEntryFields = require("../../lib/withEntryFields");
const asRetriever = require("../../lib/asRetriever");
const { MAX_ENTRIES } = require("../../lib/limits");
const Archives = require("models/archives");

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

async function archives(req, res) {
  const blogID = req.blog.id;
  const fields = entryFieldList(req.retrieve, ["archives"]);

  // Belt-and-suspenders: app/sync/fix/archives-index.js keeps this warm on
  // every sync, but a blog that hasn't synced or been backfilled yet (see
  // scripts/archives/backfill.js) gets it built here on first render.
  if (!(await Archives.isReady(blogID))) {
    await new Promise((resolve, reject) => {
      Archives.rebuild(blogID, (err) => (err ? reject(err) : resolve()));
    });
  }

  // Months are precomputed (bucketed by blog.timeZone when each entry was
  // saved - see models/archives/set.js), so no per-entry date/timezone work
  // happens here. Archives.months() already returns each month's count, so
  // the months actually needed for the MAX_ENTRIES clamp can be decided
  // without fetching any bucket first - then every bucket read for those
  // months happens in parallel (one round trip, not one per month).
  const months = await Archives.months(blogID);
  const monthsNeeded = [];
  let total = 0;

  for (const month of months) {
    if (total >= MAX_ENTRIES) break;

    monthsNeeded.push(month);
    total += month.count;
  }

  const buckets = await Promise.all(
    monthsNeeded.map((month) => Archives.bucket(blogID, month.yearMonth))
  );

  let remaining = MAX_ENTRIES;
  const monthEntryIDs = monthsNeeded.map((month, i) => {
    const ids = buckets[i].slice(0, remaining);
    remaining -= ids.length;
    return { yearMonth: month.yearMonth, ids };
  });

  const allIDs = [].concat(...monthEntryIDs.map((m) => m.ids));

  let entries;
  if (!fields) {
    entries = await getEntry(blogID, allIDs);
  } else {
    entries = await withEntryFields(
      () => getEntry(blogID, allIDs, fields),
      () => getEntry(blogID, allIDs)
    );
  }

  projectEntryFields(entries, req.retrieve, ["archives"]);

  const byID = new Map(entries.map((entry) => [entry.id, entry]));

  const years = {};

  for (const { yearMonth, ids } of monthEntryIDs) {
    const [year, monthNumber] = yearMonth.split("-");
    const month = MONTH_NAMES[parseInt(monthNumber, 10) - 1];

    years[year] = years[year] || {
      year: year,
      total: 0,
      months: {},
    };

    years[year].months[month] = years[year].months[month] || {
      month: month,
      entries: [],
    };

    for (const id of ids) {
      const entry = byID.get(id);
      // Entry vanished between the index read and the fetch above (e.g.
      // deleted mid-request) - the index will self-correct on its next save.
      if (!entry) continue;

      years[year].months[month].entries.push(entry);
      years[year].total++;
    }
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
}

module.exports = asRetriever(archives);
