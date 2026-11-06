const moment = require("moment");
const folder = require("storage/folder");

require("moment-timezone");

// Formats a stat of storage/folder (modified is in milliseconds) for display
const format = (stat, timeZone) => {
  const mtime = new Date(stat.modified);
  const result = {};

  result.modified = moment.utc(mtime).tz(timeZone).calendar(null, {
    sameDay: "[Today], h:mm A",
    lastDay: "[Yesterday], h:mm A",
    lastWeek: "LL, h:mm A",
    sameElse: "LL, h:mm A",
  });

  result.updated = moment.utc(mtime).from(moment.utc());
  result.unix = mtime.getTime();
  result.bytes = stat.size;
  result.size = humanFileSize(stat.size);
  result.directory = stat.isDirectory;
  result.file = !stat.isDirectory;

  return result;
};

module.exports = async (blogID, path, timeZone) => {
  return format(await folder.stat(blogID, path), timeZone);
};

module.exports.format = format;

function humanFileSize(size) {
  if (size === 0) return "0 kb";

  const i = Math.floor(Math.log(size) / Math.log(1024));

  return (
    Math.ceil(size / Math.pow(1024, i)) +
    " " +
    ["bytes", "kB", "MB", "GB", "TB"][i]
  );
}
