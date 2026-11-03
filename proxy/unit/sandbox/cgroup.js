// Makes a cgroup for a jail that nsjail can't make itself, because a jail with
// a network is started by its own uid (./jail.js): the proxy jail's and the
// fetch-image job's, in the unit's sandbox subtree. Root only. oom.group: a jail
// over its limit goes whole. Whatever an earlier jail left in it is killed.

const fs = require("fs");

function prepare(directory, { memoryBytes, pids }) {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(directory + "/memory.max", String(memoryBytes));
  fs.writeFileSync(directory + "/memory.swap.max", "0");
  fs.writeFileSync(directory + "/memory.oom.group", "1");
  fs.writeFileSync(directory + "/pids.max", String(pids));
  fs.writeFileSync(directory + "/cgroup.kill", "1");
}

module.exports = { prepare };
