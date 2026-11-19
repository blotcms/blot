const moment = require("moment");
require("moment-timezone");

module.exports = function formatDashboardDate(timestamp, timeZone) {
  return moment.utc(timestamp).tz(timeZone).calendar(null, {
    sameDay: "[Today], h:mm A",
    lastDay: "[Yesterday], h:mm A",
    lastWeek: "LL, h:mm A",
    sameElse: "LL, h:mm A",
  });
};
