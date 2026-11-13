const folder = require("storage/folder");
const formatDashboardDate = require("dashboard/util/format-dashboard-date");

// Formats a stat of storage/folder (modified is in milliseconds) for display
const format = (stat, timeZone) => {
  const mtime = new Date(stat.modified);
  const result = {};

  result.modified = formatDashboardDate(mtime, timeZone);

  result.unix = mtime.getTime();
  result.bytes = stat.size;
  result.size = humanFileSize(stat.size);
  result.directory = stat.isDirectory;
  result.file = !stat.isDirectory;

  // What went wrong with the file, if anything (models/file/flags.js)
  if (stat.flags) result.flags = stat.flags;

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
