var moment = require("moment");
require("moment-timezone");

// "YYYY-MM" bucket an entry with this dateStamp belongs to, in the blog's timezone.
function yearMonth(dateStamp, timeZone) {
  return moment.utc(dateStamp).tz(timeZone).format("YYYY-MM");
}

// Numeric sort key for a "YYYY-MM" string, e.g. "2024-03" -> 202403.
function score(yearMonthString) {
  return parseInt(yearMonthString.replace("-", ""), 10);
}

// Same rule app/models/entry/_assign.js uses to decide whether an entry
// belongs in the "entries" list - archives should show exactly those posts.
function visible(entry) {
  return !(
    entry.menu ||
    entry.scheduled ||
    entry.page ||
    entry.deleted ||
    entry.draft
  );
}

// yearMonth() needs a real dateStamp to bucket by - without this check, an
// entry with a missing/non-numeric dateStamp would fall through to
// moment.utc(undefined), which resolves to "now" and silently buckets it
// into the current month. rebuild() already skips these entries entirely,
// so set() has to use the same rule or an incremental save and a full
// rebuild would disagree about where (or whether) such an entry appears.
function hasDateStamp(entry) {
  return typeof entry.dateStamp === "number";
}

module.exports = {
  yearMonth: yearMonth,
  score: score,
  visible: visible,
  hasDateStamp: hasDateStamp,
};
