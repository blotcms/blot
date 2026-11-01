// The unit's forward proxy, in a long-running jail. Runs as root inside the
// unit, started by the supervisor (proxy/unit/supervisor.sh) with a clean
// environment and restarted by it when it exits. It makes the jail's cgroup,
// which only root can, and waits on the jail. Like the broker it is root-owned
// and requires only Node built-ins and ./jail. See app/sandbox/README.md.

const fs = require("fs");
const { spawn } = require("child_process");
const jail = require("./jail");

const MiB = 1024 * 1024;

// In the unit's sandbox subtree, so it shares that budget with the image jobs.
// oom.group: the supervisor starts a whole new jail, not half of one.
function prepareCgroup(directory) {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(directory + "/memory.max", String(128 * MiB));
  fs.writeFileSync(directory + "/memory.swap.max", "0");
  fs.writeFileSync(directory + "/memory.oom.group", "1");
  fs.writeFileSync(directory + "/pids.max", "128");
  // anything left by a proxy that died hard holds the port
  fs.writeFileSync(directory + "/cgroup.kill", "1");
}

function start(unit) {
  prepareCgroup(jail.PROXY_CGROUP);
  const { file, args } = jail.proxyCommand(unit);
  const child = spawn(file, args, { stdio: ["ignore", "inherit", "inherit"], env: {} });

  const stop = () => child.kill("SIGTERM");
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);

  child.on("error", (err) => {
    console.error("proxy jail: cannot start:", err.message);
    process.exit(1);
  });
  child.on("exit", (code, signal) => {
    console.error(`proxy jail: exited code=${code} signal=${signal}`);
    process.exit(code === 0 ? 0 : 1);
  });
}

module.exports = { prepareCgroup, start };

if (require.main === module) {
  if (typeof process.getuid === "function" && process.getuid() !== 0) {
    console.error("proxy jail: must run as root");
    process.exit(1);
  }
  start(process.env.BLOT_UNIT);
}
