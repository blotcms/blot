// The data disk line of the daily email, one line:
//
//   Data disk: 85% used, 49.5 GB free of 330 GB
//
// Bold from the first alert level (free-disk-space.js), which also emails as
// soon as it is reached. This never fails the rest of the email.
const freeDiskSpace = require("../free-disk-space");

// In GiB, as df -h and the EBS volume size count them
const gb = (k) => Math.round((k / 1024 / 1024) * 10) / 10 + " GB";

function line(disks) {
  const data = disks.find(disk => disk.label === "data");

  if (!data) return "Data disk: not found";

  const text =
    "Data disk: " +
    data.used_percent +
    "% used, " +
    gb(data.available_k) +
    " free of " +
    gb(data.used_k + data.available_k);

  return freeDiskSpace.dataDiskAlert(disks) ? "**" + text + "**" : text;
}

function main(callback, deps = {}) {
  (deps.freeDiskSpace || freeDiskSpace)(function (err, disks) {
    if (err || !disks) {
      const reason = String((err && err.message) || err).slice(0, 80);
      return callback(null, { data_disk: "Data disk: unavailable (" + reason + ")" });
    }

    callback(null, { data_disk: line(disks) });
  });
}

module.exports = main;
module.exports.line = line;

if (require.main === module) require("./cli")(main);
