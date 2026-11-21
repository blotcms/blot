const moment = require("moment");
require("moment-timezone");

// An entry's Event line, read as a date and time in the blog's time zone:
//
//   Event: 2026-12-08 18:30
//   Event: 2026-12-08            (a whole day)
//
// and, optionally, how it repeats from there:
//
//   Repeats: weekly | fortnightly | monthly | yearly
//   Until: 2027-06-30
//
// Monthly repeats keep the weekday of the month (the second Tuesday). Returns
// { stamp, allDay, repeats, until } or null when the line is missing or isn't
// a date in one of these forms (a template then shows the line as written).
const FORMATS = [
  "YYYY-MM-DD HH:mm",
  "YYYY-MM-DDTHH:mm",
  "YYYY-MM-DD H:mm",
  "YYYY-MM-DD h:mm a",
  "YYYY-MM-DD h:mma",
];

const REPEATS = {
  weekly: "weekly",
  "every week": "weekly",
  fortnightly: "fortnightly",
  "every two weeks": "fortnightly",
  "every other week": "fortnightly",
  biweekly: "fortnightly",
  monthly: "monthly",
  "every month": "monthly",
  yearly: "yearly",
  annually: "yearly",
  "every year": "yearly",
};

// Metadata keys are matched in any case (Event, EVENT, event), as the rest
// of Blot matches them
function read(metadata, key) {
  if (!metadata || typeof metadata !== "object") return undefined;
  let value = metadata[key];
  if (value === undefined) {
    const match = Object.keys(metadata).find((k) => k.toLowerCase() === key);
    if (match) value = metadata[match];
  }
  return typeof value === "string" ? value.trim() : undefined;
}

function eventDate(metadata, timeZone) {
  const text = read(metadata, "event");
  if (!text) return null;

  const zone = timeZone || "UTC";
  let parsed = null;

  const timed = moment.tz(text, FORMATS, true, zone);
  if (timed.isValid()) parsed = { stamp: timed.valueOf(), allDay: false };

  if (!parsed) {
    const day = moment.tz(text, "YYYY-MM-DD", true, zone);
    if (day.isValid()) parsed = { stamp: day.valueOf(), allDay: true };
  }

  if (!parsed) return null;

  // Ends: a date makes a multi-day event (Ends: 2027-02-21), upcoming until
  // that day is over. A time (Ends: 9 pm) is left for the template to show.
  const ends = moment.tz(
    read(metadata, "ends") || "",
    "YYYY-MM-DD",
    true,
    zone
  );
  if (ends.isValid() && ends.valueOf() >= parsed.stamp) {
    parsed.endsDay = ends.valueOf();
  }

  const repeats = REPEATS[(read(metadata, "repeats") || "").toLowerCase()];
  if (repeats) {
    parsed.repeats = repeats;
    const until = moment.tz(
      read(metadata, "until") || "",
      "YYYY-MM-DD",
      true,
      zone
    );
    if (until.isValid()) parsed.until = until.endOf("day").valueOf();
  }

  return parsed;
}

// The end of an occurrence, for deciding whether it is still to come: a
// timed event ends when it starts, a whole-day event at the end of its day.
function endOf(stamp, allDay, zone) {
  return allDay ? moment.tz(stamp, zone).endOf("day").valueOf() : stamp;
}

// How many days after its first day a multi-day event ends (0 otherwise)
function extraDays(parsed, zone) {
  if (!parsed.endsDay) return 0;
  return moment
    .tz(parsed.endsDay, zone)
    .diff(moment.tz(parsed.stamp, zone).startOf("day"), "days");
}

// The last day of the occurrence that starts at stamp: a repeating
// multi-day event keeps its length each time. Null for a one-day event.
function endsOn(parsed, stamp, timeZone) {
  if (!parsed || !parsed.endsDay) return null;
  const zone = timeZone || "UTC";
  return moment
    .tz(stamp, zone)
    .startOf("day")
    .add(extraDays(parsed, zone), "days")
    .valueOf();
}

// When the occurrence that starts at stamp stops being upcoming: the end of
// its last day for a multi-day event, else as endOf.
function occurrenceEnd(parsed, stamp, zone) {
  if (parsed.endsDay)
    return moment
      .tz(endsOn(parsed, stamp, zone), zone)
      .endOf("day")
      .valueOf();
  return endOf(stamp, parsed.allDay, zone);
}

// The occurrence of a repeating event `step` repeats after its first.
function occurrence(parsed, step, zone) {
  const first = moment.tz(parsed.stamp, zone);
  if (parsed.repeats === "weekly") return first.clone().add(step, "weeks");
  if (parsed.repeats === "fortnightly")
    return first.clone().add(step * 2, "weeks");
  if (parsed.repeats === "yearly") return first.clone().add(step, "years");

  // Monthly: the same weekday of the month (the second Tuesday), or the last
  // one in a month that has fewer (a fifth Thursday).
  const nth = Math.ceil(first.date() / 7);
  const month = first.clone().startOf("month").add(step, "months");
  const firstMatch = 1 + ((first.day() - month.day() + 7) % 7);
  let date = firstMatch + 7 * (nth - 1);
  if (date > month.daysInMonth()) date -= 7;
  return month.date(date).set({
    hour: first.hour(),
    minute: first.minute(),
    second: 0,
    millisecond: 0,
  });
}

// The next time an event happens at or after `now`: the event itself if it
// is still to come, else for a repeating one its next occurrence (until its
// Until date). Returns a stamp, or null when it has all happened.
function next(parsed, now, timeZone) {
  if (!parsed) return null;
  const zone = timeZone || "UTC";

  if (occurrenceEnd(parsed, parsed.stamp, zone) >= now) return parsed.stamp;
  if (!parsed.repeats) return null;

  for (let step = 1; step < 5000; step++) {
    const stamp = occurrence(parsed, step, zone).valueOf();
    if (parsed.until && stamp > parsed.until) return null;
    if (occurrenceEnd(parsed, stamp, zone) >= now) return stamp;
  }

  return null;
}

// The next moment, after now, at which what a page says about this event
// changes: just after the occurrence it would show ends. Null once it has
// all happened.
function nextChange(parsed, now, timeZone) {
  const zone = timeZone || "UTC";
  const stamp = next(parsed, now, zone);
  if (stamp === null) return null;
  return occurrenceEnd(parsed, stamp, zone) + 1;
}

// Which weekday of the month, for BYDAY: 1 to 4, or -1 (the last) for a
// fifth, which occurrence() moves to the last in a month without one
function monthlyOrdinal(first) {
  const nth = Math.ceil(first.date() / 7);
  return nth === 5 ? -1 : nth;
}

// An iCalendar RRULE for a repeating event, e.g. FREQ=MONTHLY;BYDAY=2TU.
function rrule(parsed, timeZone) {
  if (!parsed || !parsed.repeats) return "";
  const first = moment.tz(parsed.stamp, timeZone || "UTC");
  const days = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
  let rule =
    parsed.repeats === "weekly"
      ? "FREQ=WEEKLY"
      : parsed.repeats === "fortnightly"
        ? "FREQ=WEEKLY;INTERVAL=2"
        : parsed.repeats === "yearly"
          ? "FREQ=YEARLY"
          : "FREQ=MONTHLY;BYDAY=" + monthlyOrdinal(first) + days[first.day()];
  if (parsed.until)
    rule += ";UNTIL=" + moment.utc(parsed.until).format("YYYYMMDD[T]HHmmss[Z]");
  return rule;
}

module.exports = eventDate;

// Whether an event is still to come (a repeating one: whether any occurrence
// is), as of `now`.
module.exports.isUpcoming = function isUpcoming(parsed, now, timeZone) {
  return next(parsed, now, timeZone) !== null;
};

module.exports.next = next;
module.exports.nextChange = nextChange;
module.exports.endsOn = endsOn;
module.exports.rrule = rrule;
