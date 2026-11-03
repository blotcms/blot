// The jobs the sandbox runs, and the nsjail command line for each. Pure: it
// starts nothing. The broker (./broker.js) runs as root and is the only caller.
// See app/sandbox/README.md for why each flag is what it is.

const path = require("path");

const MiB = 1024 * 1024;

// Encoded images pass through /tmp (app/sandbox/jobs/encode.js). A tmpfs counts
// toward the job's memory limit, so this is a ceiling, not a reservation.
const TMPFS_BYTES = 128 * MiB;

// Where the Dockerfile puts the nsjail binary, and the unit's cgroup subtree
// that the host binds in (proxy/deploy/common.sh)
const NSJAIL = "/usr/local/bin/nsjail";
const SU_EXEC = "/sbin/su-exec";
const CGROUP_MOUNT = "/sandbox-cgroup";
const POLICY = path.join(__dirname, "policy.kafel");
const NETWORK_POLICY = path.join(__dirname, "policy-browser.kafel");
const NETWORK_CONFIG = path.join(__dirname, "network.cfg");
const ENTER_NETWORK = path.join(__dirname, "enter-network.sh");

// The unit's browser cgroup, which the host binds in (proxy/deploy/common.sh)
const BROWSER_CGROUP = "/sandbox-browser-cgroup";
// The proxy jail's, in the unit's subtree. ./proxy.js makes it.
const PROXY_CGROUP = CGROUP_MOUNT + "/proxy";
// The fetch-image job's, in the unit's subtree too, so it shares that budget
// with the image jobs and the proxy jail. The broker makes it (./cgroup.js),
// with the job's cgroupLimits. The fetch job runs in it too, so the two take
// turns and add no memory.
const FETCH_CGROUP = CGROUP_MOUNT + "/fetch";

// pasta can't start from a root nsjail, so a jail with a network is started by
// its own uid, which is also the job's uid outside the namespace
const NETWORK_UID = 65001;

// The job code runs under node: /usr/src/app/app/sandbox/jobs/main.js <name>
const node = (name) => [
  "/usr/local/bin/node",
  "/usr/src/app/app/sandbox/jobs/main.js",
  name,
];

// A job is a name from this table, never a path or a command from the client
const JOBS = {
  metadata: {
    command: node("metadata"),
    memoryBytes: 512 * MiB,
    timeSeconds: 30,
    maxInputBytes: 256 * MiB,
    maxOutputBytes: 1 * MiB,
  },
  thumbnail: {
    command: node("thumbnail"),
    memoryBytes: 512 * MiB,
    timeSeconds: 60,
    maxInputBytes: 256 * MiB,
    maxOutputBytes: 64 * MiB,
  },
  resize: {
    command: node("resize"),
    memoryBytes: 512 * MiB,
    timeSeconds: 60,
    maxInputBytes: 256 * MiB,
    maxOutputBytes: 64 * MiB,
  },
  "to-png": {
    command: node("to-png"),
    memoryBytes: 512 * MiB,
    timeSeconds: 60,
    maxInputBytes: 256 * MiB,
    maxOutputBytes: 64 * MiB,
  },
  // A template image setting: the decode check, the original and its
  // thumbnails (app/build/thumbnail/template-image.js)
  "template-image": {
    command: node("template-image"),
    memoryBytes: 512 * MiB,
    timeSeconds: 60,
    maxInputBytes: 256 * MiB,
    maxOutputBytes: 64 * MiB,
  },
  // A template's favicon set: one ICO and a few PNGs
  favicon: {
    command: node("favicon"),
    memoryBytes: 512 * MiB,
    timeSeconds: 60,
    maxInputBytes: 256 * MiB,
    maxOutputBytes: 8 * MiB,
  },
  // Spawns pandoc on one document (docx, odt, rtf, org or markdown, with a
  // bibliography and CSL) and returns the HTML and any media it extracted.
  // pandoc caps its own heap at 400M, so most documents too large for the
  // jail fail as pandoc errors, and is killed after 10s by the job. A very
  // large docx or odt (tens of MB of images: the document and its media sit
  // in /tmp and in Node too) can still exceed the jail and fail the job.
  pandoc: {
    command: node("pandoc"),
    memoryBytes: 512 * MiB,
    timeSeconds: 30,
    maxInputBytes: 256 * MiB,
    maxOutputBytes: 64 * MiB,
  },
  // A zip archive, read into its files (app/sandbox/jobs/unzip.js): the
  // archive in memory, then every file. The output stops under the 64 MiB a
  // reply may hold (app/sandbox/index.js), with the file names.
  unzip: {
    command: node("unzip"),
    memoryBytes: 512 * MiB,
    timeSeconds: 30,
    maxInputBytes: 64 * MiB,
    maxOutputBytes: 60 * MiB,
  },
  // Spawns perl, which runs exiftool, reading the image from stdin
  exif: {
    command: node("exif"),
    memoryBytes: 512 * MiB,
    timeSeconds: 30,
    maxInputBytes: 256 * MiB,
    maxOutputBytes: 1 * MiB,
  },
  // One Chromium per job, on the open internet behind the egress filter, in
  // the unit's browser cgroup: that cgroup's limits replace memoryBytes, and
  // one job at a time keeps a heavy page's memory to itself. A job with a
  // network runs in one of its cgroups, which holds one jail at a time.
  // A job is a batch of up to 8 pages taken one after the other in that one
  // Chromium (app/sandbox/jobs/screenshot.js). A page takes 25s at worst, so
  // 8 of them could not fit anywhere: the job stops starting pages 90s in and
  // hands the rest back to be sent again, so this is the backstop, not the
  // plan. Its replies are at most 56 MiB of PNGs.
  screenshot: {
    command: [
      "/usr/local/bin/node",
      "/usr/src/app/app/sandbox/jobs/main.js",
      "screenshot",
    ],
    network: true,
    cgroups: [BROWSER_CGROUP],
    timeSeconds: 100,
    maxInputBytes: 64 * 1024,
    maxOutputBytes: 60 * MiB,
  },
  // Fetches one image from a URL and re-encodes it (remote images in posts,
  // helper/transformer/download), behind the egress filter like the browser
  // job but with no browser, /proc or fonts. One at a time: posts' remote
  // images are background build work, and a slow server holding the rest up
  // for its time limit is acceptable. Its own short queue keeps a backlog of
  // them out of the broker's, which the dashboard's jobs use too: a fetch
  // over it is busy, and the post keeps its remote link.
  "fetch-image": {
    command: node("fetch-image"),
    network: true,
    cgroups: [FETCH_CGROUP],
    cgroupLimits: { memoryBytes: 256 * MiB, pids: 64 },
    maxQueued: 8,
    timeSeconds: 30,
    maxInputBytes: 64 * 1024,
    maxOutputBytes: 50 * MiB,
  },
  // A batch of up to 32 URLs fetched one after the other in one jail: an
  // import's images, audio and PDFs, domain and featured-site checks. The same
  // jail as fetch-image and the same cgroup, which fetch-image's entry makes
  // and sizes, so the two take turns on one slot and no memory is added. Its
  // own queue (the broker queues oldest first across both) is what keeps a big
  // import from filling fetch-image's, and the reverse. A batch is at most 60s,
  // its bodies together at most 50 MiB (app/sandbox/jobs/fetch.js).
  fetch: {
    command: node("fetch"),
    network: true,
    cgroups: [FETCH_CGROUP],
    maxQueued: 16,
    timeSeconds: 75,
    maxInputBytes: 256 * 1024,
    maxOutputBytes: 52 * MiB,
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
  "/usr/local/bin/pandoc",
  "/usr/src/app/node_modules",
  "/usr/src/app/app/sandbox",
];

// What every jail with a network adds. Never /etc/ssl: the unit's TLS private
// keys are mounted at /etc/ssl/private. The two /bin directories hold the shell,
// awk, sed, nft and setpriv that enter-network.sh runs.
const NETWORK_BINDS = [
  "/bin",
  "/sbin",
  "/usr/sbin",
  "/etc/resolv.conf",
  "/etc/passwd",
  "/etc/group",
  "/dev/null",
  "/dev/urandom",
  path.dirname(ENTER_NETWORK),
];

// What the browser job adds to those and BINDS. /proc is the container's,
// read-only, because Chromium won't start without one and a fresh one can't be
// mounted (see app/sandbox/README.md).
const BROWSER_BINDS = [
  "/proc",
  "/usr/share/fonts",
  "/usr/share/fontconfig",
  "/etc/fonts",
  "/etc/ssl/certs",
];

// The proxy needs no Node, app code or /proc
const PROXY_BINDS = ["/lib", "/usr/lib", "/usr/bin"];

// What each job with a network adds to BINDS and NETWORK_BINDS, how many files
// it may hold open, and its environment
const NETWORK_JOBS = {
  screenshot: {
    binds: BROWSER_BINDS,
    // Chromium needs more of these than a converter does
    nofile: 1024,
    env: [
      "NODE_PATH=/usr/src/app/node_modules",
      "HOME=/tmp",
      "PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser",
    ],
  },
  "fetch-image": {
    binds: [],
    nofile: 256,
    env: ["NODE_PATH=/usr/src/app/node_modules"],
  },
  fetch: {
    binds: [],
    nofile: 256,
    env: ["NODE_PATH=/usr/src/app/node_modules"],
  },
};

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
    "-m", `none:/tmp:tmpfs:size=${TMPFS_BYTES}`,
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

// nsjail's arguments for a jail with a network. It differs from args() in three
// ways: the jail is started by NETWORK_UID, so nsjail can't make cgroups itself
// and the jail's memory and pids limits are its cgroup's; the job keeps its
// capabilities until enter-network.sh has loaded the filter and dropped them;
// and the seccomp policy allows the sockets it needs. opts: { config, binds,
// timeSeconds, nofile, env, command }.
function networkArgs({ config, binds, timeSeconds, nofile, env, command }) {
  const flags = [
    "--config", config,
    "-Mo",
    "--really_quiet",
    "--disable_proc",
    "--hostname", "sandbox",
    "--cwd", "/",
    "-m", `none:/tmp:tmpfs:size=${256 * MiB}`,
    "--time_limit", String(timeSeconds),
    "-u", `65000:${NETWORK_UID}:1`,
    "-g", `65000:${NETWORK_UID}:1`,
    "--keep_caps",
  ];
  for (const bind of binds) flags.push("-R", bind);
  flags.push(
    "--rlimit_as", "hard",
    "--rlimit_cpu", timeSeconds ? String(timeSeconds) : "inf",
    "--rlimit_fsize", "256",
    "--rlimit_nofile", String(nofile),
    "--rlimit_core", "0",
    "--seccomp_policy", NETWORK_POLICY,
    "-E", "PATH=/usr/bin:/bin:/usr/sbin:/sbin"
  );
  for (const variable of env) flags.push("-E", variable);
  return flags.concat("--", "/bin/sh", ENTER_NETWORK, command);
}

// Under host-wide memory pressure the kernel kills the process with the highest
// score. A job fails closed and is cheap to lose, so it goes before the units'
// Node (node-b 900, app/index.js; node-a 0), level with Redis's BGSAVE child
// (1000, config/redis/redis.conf), which is larger and so still goes first. Raising it needs no privilege, the
// jail inherits it, and the job's uid can't lower it again. The proxy jail
// keeps the unit's: it is small and serves every fetch.
const OOM_SCORE_ADJ = 1000;
const RAISE_OOM_SCORE = `echo ${OOM_SCORE_ADJ} > /proc/self/oom_score_adj`;

// Puts this shell in the job's cgroup, which only root can do, and becomes the
// jail's own uid. Everything in it comes from this file, none from the client.
const ENTER_CGROUP = 'echo $$ > "$1/cgroup.procs" && shift && exec "$@"';

// Starts a jail in a cgroup, as NETWORK_UID
function inCgroup(cgroup, args, { raiseOomScore }) {
  const script = raiseOomScore ? `${RAISE_OOM_SCORE} && ${ENTER_CGROUP}` : ENTER_CGROUP;
  return {
    file: "/bin/sh",
    args: [
      "-c", script, "sh", cgroup,
      SU_EXEC, `${NETWORK_UID}:${NETWORK_UID}`, NSJAIL,
    ].concat(args),
  };
}

// The program and arguments that start a job's jail; for a job with a
// network, in one of its cgroups, the first unless the broker picks another
function command(name, cgroup) {
  const j = job(name);
  if (!j.network) {
    return {
      file: "/bin/sh",
      args: ["-c", `${RAISE_OOM_SCORE} && exec "$@"`, "sh", NSJAIL].concat(args(name)),
    };
  }
  const directory = cgroup || j.cgroups[0];
  if (!j.cgroups.includes(directory)) throw new Error("unknown cgroup");
  const extra = NETWORK_JOBS[name];
  return inCgroup(
    directory,
    networkArgs({
      config: NETWORK_CONFIG,
      binds: BINDS.concat(NETWORK_BINDS, extra.binds),
      timeSeconds: j.timeSeconds,
      nofile: extra.nofile,
      env: extra.env,
      command: j.command,
    }),
    { raiseOomScore: true }
  );
}

// The program and arguments that start a unit's proxy jail, which runs until it
// is stopped: no time limit. Its port is in its config, so it isn't passed in.
function proxyCommand(unit) {
  if (unit !== "blue" && unit !== "green") throw new Error("unknown unit");
  return inCgroup(
    PROXY_CGROUP,
    networkArgs({
      config: path.join(__dirname, `network-proxy-${unit}.cfg`),
      binds: PROXY_BINDS.concat(NETWORK_BINDS),
      timeSeconds: 0,
      // A connection each way for each of tinyproxy's MaxClients
      nofile: 256,
      env: ["BLOT_PROXY_JAIL=1"],
      command: ["/usr/bin/tinyproxy", "-d", "-c", path.join(__dirname, "tinyproxy.conf")],
    }),
    { raiseOomScore: false }
  );
}

module.exports = { JOBS, NSJAIL, BROWSER_CGROUP, PROXY_CGROUP, FETCH_CGROUP, OOM_SCORE_ADJ, job, args, command, proxyCommand };
