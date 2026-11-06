var ensure = require("helper/ensure");

var moment = require("moment");
require("moment-timezone");

module.exports = function (blogID, timeZone, callback) {
  ensure(blogID, "string").and(timeZone, "string").and(callback, "function");

  timeZone = timeZone.trim();

  if (!timeZone) return callback(null, "UTC");

  if (moment.tz.zone(timeZone)) return callback(null, timeZone);

  return callback(null, "UTC");
};
