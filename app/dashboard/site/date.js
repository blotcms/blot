const moment = require("moment-timezone");

// Formats and their aliases
const formats = ["D/M/YYYY", "M/D/YYYY", "YYYY/M/D"];
const alias = {
  "D/M/YYYY": "Day-Month-Year",
  "M/D/YYYY": "Month-Day-Year",
  "YYYY/M/D": "Year-Month-Day",
};

// Excluded time zones
const excludedZones = [
  "Pacific/Marquesas",
  "America/Caracas",
  "Asia/Kabul",
  "Asia/Pyongyang",
  "Australia/Eucla",
  "Pacific/Chatham",
  "US/Pacific-New",
  "Asia/Tehran",
  "Asia/Katmandu",
  "Asia/Kathmandu",
  "Etc/GMT-14",
  "Pacific/Apia",
  "Pacific/Kiritimati",
];

// Included time zones
const includedZones = ["UTC", "Pacific/Auckland"];

const zones = moment.tz.names().filter((zone) => {
  if (excludedZones.includes(zone)) return false;
  if (includedZones.includes(zone)) return true;
  if (
    zone.startsWith("Etc/") ||
    zone.startsWith("Pacific/") ||
    zone.includes("Antarctica")
  )
    return false;
  return /\//.test(zone);
});

// The list shows each zone's current time, so it changes once a minute
let cachedMinute;
let cachedTimeZones;

function timeZonesAt(when) {
  const minute = Math.floor(when / 60000);
  if (minute === cachedMinute) return cachedTimeZones;

  cachedTimeZones = zones
    .map((zone) => ({
      time: moment.utc(when).tz(zone).format("h:mm a"),
      value: zone,
      offset: moment.tz.zone(zone).utcOffset(when),
    }))
    .sort((a, b) => b.offset - a.offset || a.value.localeCompare(b.value));
  cachedMinute = minute;

  return cachedTimeZones;
}

function loadDateSettings(req, res, next) {
  const timeZones = timeZonesAt(Date.now()).map((zone) => ({
    ...zone,
    selected: zone.value === req.blog.timeZone ? "selected" : "",
  }));

  res.locals.timeZones = timeZones;
  res.locals.currentTime = moment
    .utc()
    .tz(req.blog.timeZone)
    .format("h:mma, MMMM D");
  res.locals.dateFormats = formats.map((format) => ({
    value: format,
    selected: format === req.blog.dateFormat ? "selected" : "",
    date: alias[format],
  }));
  next();
}

module.exports = { loadSettings: loadDateSettings };
