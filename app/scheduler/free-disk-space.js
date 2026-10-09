const exec = require("child_process").exec;
const prettySize = require("helper/prettySize");

// we care about three disks:
// / - the root disk
// /var/www/blot/data - the data disk
// /var/instance-ssd - the ephemeral instance Disk
// Inside an app container df lists the bind mounts at their container paths
// instead (scripts/deploy/util/generateDockerCommand.js): the data disk at
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

module.exports = main;

if (require.main === module) {
  console.log("Checking free disk space...");
  main(function (err, disks) {
    if (err) throw err;
    console.log("Disks", disks);
    console.log("Check complete!");
    process.exit();
  });
}
