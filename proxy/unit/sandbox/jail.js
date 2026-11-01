// The jobs the sandbox runs, and the nsjail command line for each. Pure: it
// starts nothing. The broker (./broker.js) runs as root and is the only caller.
// See app/sandbox/README.md for why each flag is what it is.

const path = require("path");

const MiB = 1024 * 1024;

// Where the Dockerfile puts the nsjail binary, and the unit's cgroup subtree
// that the host binds in (proxy/deploy/common.sh)
const NSJAIL = "/usr/local/bin/nsjail";
const CGROUP_MOUNT = "/sandbox-cgroup";
const POLICY = path.join(__dirname, "policy.kafel");

// A job is a name from this table, never a path or a command from the client
const JOBS = {
  metadata: {
    command: [
      "/usr/local/bin/node",
      "/usr/src/app/app/sandbox/jobs/main.js",
      "metadata",
    ],
    memoryBytes: 512 * MiB,
    timeSeconds: 30,
    maxInputBytes: 256 * MiB,
    maxOutputBytes: 1 * MiB,
  },
};

// Read-only binds, and nothing else. nsjail binds are recursive, so never bind
// /usr or /: /usr/src/app/data is the blog data mount. The jail has no /bin,
// so a #!/usr/bin/env script can't start: run the interpreter directly.
// The last one is the job code, read-only like the rest.
const BINDS = [
  "/lib",
  "/usr/lib",
  "/usr/bin",
  "/usr/share/perl5",
  "/usr/local/bin/node",
  "/usr/src/app/node_modules",
  "/usr/src/app/app/sandbox",
];

function job(name) {
  if (typeof name !== "string" || !Object.prototype.hasOwnProperty.call(JOBS, name)) {
    throw new Error("unknown job");
  }
  return JOBS[name];
}

// nsjail's arguments (without the binary) for one job
function args(name) {
  const j = job(name);
  const flags = [
    "-Mo",
    "--really_quiet",
    "--disable_proc",
    "--hostname", "sandbox",
    "--cwd", "/",
    "-T", "/tmp",
    "--time_limit", String(j.timeSeconds),
    // uid 65000 inside and outside. Never --user: as root it leaves the job
    // mapped to root outside the namespace.
    "-u", "65000:65000:1",
    "-g", "65000:65000:1",
  ];
  for (const bind of BINDS) flags.push("-R", bind);
  flags.push(
    "--rlimit_as", "hard",
    "--rlimit_cpu", String(j.timeSeconds),
    "--rlimit_fsize", "256",
    "--rlimit_nofile", "64",
    "--rlimit_core", "0",
    "--use_cgroupv2",
    "--cgroupv2_mount", CGROUP_MOUNT,
    "--cgroup_mem_max", String(j.memoryBytes),
    "--cgroup_mem_swap_max", "0",
    "--cgroup_pids_max", "64",
    "--cgroup_cpu_ms_per_sec", "1000",
    "--seccomp_policy", POLICY,
    // nsjail passes no environment; this is the only variable the job gets
    "-E", "NODE_PATH=/usr/src/app/node_modules",
    "--"
  );
  return flags.concat(j.command);
}

module.exports = { JOBS, NSJAIL, job, args };
