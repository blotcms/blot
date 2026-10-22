// The data disk line of the daily email, one line:
//
//   Data disk: 85% (grow in ~40 days, 49.5 GB free)
//
// The trend comes from the last week of daily readings (daily/trend.js),
// stored at HISTORY_KEY, and aims at the first alert level
// (free-disk-space.js), which also emails as soon as it is reached. The line
// is bold from that level. This never fails the rest of the email.
const freeDiskSpace = require("../free-disk-space");
const trend = require("./trend");

// JSON [{ time, used }] of the daily runs, no TTL
const HISTORY_KEY = "blot:data-disk:daily-history";

const KB = 1024;

function line(disks, { history = [], now = Date.now() } = {}) {
  const data = disks.find(disk => disk.label === "data");

  if (!data) return "Data disk: not found";

  const alert = freeDiskSpace.DATA_DISK_ALERTS[0];
  const used = data.used_k * KB;
  // The alert goes by the rounded-up percentage shown, so "grow now" does too
  const limit = freeDiskSpace.dataDiskAlert(disks)
    ? used
    : ((data.used_k + data.available_k) * KB * alert.percent) / 100;
  const text =
    "Data disk: " +
    trend.status({
      percent: data.used_percent + "%",
      free: data.available_k * KB,
      trend: trend.trend({
        history,
        now,
        used,
        limit,
        action: "grow"
      })
    });

  return freeDiskSpace.dataDiskAlert(disks) ? "**" + text + "**" : text;
}

function main(callback, deps = {}) {
  (deps.freeDiskSpace || freeDiskSpace)(async function (err, disks) {
    if (err || !disks) {
      const reason = String((err && err.message) || err).slice(0, 80);
      return callback(null, { data_disk: "Data disk: unavailable (" + reason + ")" });
    }

    const now = deps.now || Date.now();
    let history = [];
    let client;

    // Without Redis the line just has no trend
    try {
      client = deps.client || require("models/client");
      history = trend.parse(await client.sendCommand(["GET", HISTORY_KEY]));
    } catch (e) {
      client = null;
      console.log("Daily update: could not read the data disk history:", e.message);
    }

    const result = { data_disk: line(disks, { history, now }) };
    const data = disks.find(disk => disk.label === "data");

    if (client && data) {
      await trend.save(client, HISTORY_KEY, history, { time: now, used: data.used_k * KB });
    }

    callback(null, result);
  });
}

module.exports = main;
module.exports.line = line;
module.exports.HISTORY_KEY = HISTORY_KEY;

if (require.main === module) require("./cli")(main);
