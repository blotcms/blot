const exec = require("child_process").exec;
const prettySize = require("helper/prettySize");

// we care about three disks:
// / - the root disk
// /var/www/blot/data - the data disk
// /var/instance-ssd - the ephemeral instance Disk
// Inside an app container df lists the bind mounts at their container paths
// instead (proxy/deploy/common.sh): the data disk at
// /usr/src/app/data and the instance disk at /var/instance-ssd/tmp.

const LABELS = {
  "/": "root",
  "/var/www/blot/data": "data",
  "/usr/src/app/data": "data",
  "/var/instance-ssd": "instance",
  "/var/instance-ssd/tmp": "instance"
};

const main = callback => {
  exec("df -k", function (err, stdout) {
    if (err) return callback(err);

    try {
      const disks = stdout
        .split("\n")
        .slice(1)
        .map(line => {
          const values = line.replace(/\s+/g, " ").split(" ");
          return {
            mount: values.at(-1),
            label: LABELS[values.at(-1)],
            used_k: parseInt(values.at(2)),
            // Rounded up, the way df's Use% column is
            used_percent: Math.ceil(
              (parseInt(values.at(2)) * 100) /
                (parseInt(values.at(2)) + parseInt(values.at(3)))
            ),
            used_human: prettySize(values.at(2)),
            available_k: parseInt(values.at(3)),
            available_human: prettySize(values.at(3))
          };
        })
        .filter(disk => disk.label);

      return callback(null, disks);
    } catch (e) {
      return callback(e);
    }
  });
};

// The data disk is sized close to what it holds (config/host/data-volume) and
// grows online in minutes, so it is watched by percentage. Lowest first: each
// level emails once as usage reaches it.
const DATA_DISK_ALERTS = [
  { percent: 90, headline: "Blot's data disk is 90% full" },
  { percent: 95, headline: "Warning: Blot's data disk is 95% full, grow it today" },
  {
    percent: 99,
    headline: "URGENT: Blot's data disk is 99% full, grow it NOW before writes start failing"
  }
];

// The highest alert level the data disk has reached, or null
function dataDiskAlert(disks) {
  const data = disks.find(disk => disk.label === "data");

  if (!data) return null;

  return DATA_DISK_ALERTS.filter(alert => data.used_percent >= alert.percent).pop() || null;
}

module.exports = main;
module.exports.dataDiskAlert = dataDiskAlert;
module.exports.DATA_DISK_ALERTS = DATA_DISK_ALERTS;

if (require.main === module) {
  console.log("Checking free disk space...");
  main(function (err, disks) {
    if (err) throw err;
    console.log("Disks", disks);
    console.log("Check complete!");
    process.exit();
  });
}
