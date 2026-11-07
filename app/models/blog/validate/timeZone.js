var ensure = require("helper/ensure");

var moment = require("moment");
require("moment-timezone");
var promiseOnly = require("helper/promiseOnly");

module.exports = promiseOnly(async function validateTimeZone(blogID, timeZone) {
  ensure(blogID, "string").and(timeZone, "string");

  timeZone = timeZone.trim();

  if (!timeZone) return "UTC";

  if (moment.tz.zone(timeZone)) return timeZone;

  return "UTC";
});
