const moment = require("moment");
require("moment-timezone");

// An entry's Event line, read as a date and time in the blog's time zone:
//
//   Event: 2026-12-08 18:30
//   Event: 2026-12-08            (a whole day)
//
// Returns { stamp, allDay } or null when the line is missing or isn't a
// date in one of these forms (a template then shows the line as written).
const FORMATS = [
  "YYYY-MM-DD HH:mm",
  "YYYY-MM-DDTHH:mm",
  "YYYY-MM-DD H:mm",
  "YYYY-MM-DD h:mm a",
  "YYYY-MM-DD h:mma",
];

module.exports = function eventDate(metadata, timeZone) {
  const value = metadata && (metadata.event || metadata.Event);
  if (typeof value !== "string" || !value.trim()) return null;

  const text = value.trim();
  const zone = timeZone || "UTC";

  const timed = moment.tz(text, FORMATS, true, zone);
  if (timed.isValid()) return { stamp: timed.valueOf(), allDay: false };

  const day = moment.tz(text, "YYYY-MM-DD", true, zone);
  if (day.isValid()) return { stamp: day.valueOf(), allDay: true };

  return null;
};

// Whether an event is still to come: a timed event until it starts, a
// whole-day event until the end of its day.
module.exports.isUpcoming = function isUpcoming(parsed, now, timeZone) {
  if (!parsed) return false;
  if (!parsed.allDay) return parsed.stamp >= now;
  return (
    moment
      .tz(parsed.stamp, timeZone || "UTC")
      .endOf("day")
      .valueOf() >= now
  );
};
