const exec = require("child_process").exec;
const { promisify } = require("util");
const withCallback = require("helper/withCallback");
const prettySize = require("helper/prettySize");

const execAsync = promisify(exec);

// we care about two disks:
// / - the root disk (the data directory is a plain directory on it)
// /var/instance-ssd - the ephemeral instance Disk
// Inside an app container df lists the instance disk's bind mount at its
// container path instead (proxy/deploy/common.sh): /var/instance-ssd/tmp.

const LABELS = {
  "/": "root",
  "/var/instance-ssd": "instance",
  "/var/instance-ssd/tmp": "instance",
};

const main = async () => {
  const { stdout } = await execAsync("df -k");

  return stdout
    .split("\n")
    .slice(1)
    .map((line) => {
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
        available_human: prettySize(values.at(3)),
      };
    })
    .filter((disk) => disk.label);
};

// Still callable with a callback: sync/lock-diagnostics promisifies it
module.exports = withCallback(main);

if (require.main === module) {
  console.log("Checking free disk space...");
  main().then((disks) => {
    console.log("Disks", disks);
    console.log("Check complete!");
    process.exit();
  });
}
