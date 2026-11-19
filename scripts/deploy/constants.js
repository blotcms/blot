// CPU weights (docker --cpu-shares). Docker's default weight is 1024. Shares
// only matter when the host's CPUs are contended - they decide who gets the
// CPU when there isn't enough to go around. Serving (the units' Node processes,
// which take the dashboard and blog traffic) gets twice Docker's default.
const SERVING_CPU_SHARES = 2048;

// The two units (#2119): blot-blue and blot-green, each one container holding
// OpenResty, node-a (blogs, dashboard reads) and node-b (the worker child:
// webhooks, /clients, dashboard writes), deployed by proxy/deploy/blue-green.sh
// (via ./units.sh). It gets these through ./unit-settings.js.
//
// One unit must be able to carry all the traffic on its own while the other is
// being replaced, so each is sized for everything the app does, not half of it:
// Sized from production peaks (#2795, 19 Nov 2026, about 11 hours including
// deploys; unit-mem-summary.sh on the host and the [STATS] process lines):
//   node-a   heapUsed peaked at 1072 MiB (mean ~600): 1536 leaves ~40% for GC
//   node-b   heapUsed peaked at 199 MiB: 512 leaves room for a heavy build
//   memory   the container's unreclaimable memory (anon + shmem: both Node
//            processes, OpenResty, the broker, git and scripts) peaked at
//            1966 MiB; 2560m leaves ~30%. Both heaps at their ceilings would
//            not fit, which is deliberate: under pressure the kernel kills
//            node-b (oom_score_adj 900) before node-a, and scripts first.
//            Page cache counts against this too, but it is reclaimed.
// The host's budget is the sum of enforced limits: two units at this memory,
// plus each unit's sandbox cgroups (config/host/host/setup.sh, outside this
// limit), plus Redis's maxmemory and overhead, the host itself, offsite-sync
// and a 1 GiB margin, within the host's RAM (config/redis/README.md).
// cpus overcommits slightly.
//
// Scripts run with `docker exec` in a unit are not part of that budget, so
// they get a small heap of their own (scriptMaxOldSpaceSize: the container's
// NODE_OPTIONS, which only they inherit, node-a's own options travel as
// BLOT_NODE_A_OPTIONS) and start at oom_score_adj 1000, so under memory pressure
// they are killed before node-b (900) or node-a (0). Nothing a script needs
// beyond 256 MB belongs in a unit: it goes through scripts/prod/run-script.js
// (SCRIPT_RUNNER), a container of its own outside the units' limits.
const UNIT = {
  cpus: 4,
  memory: "2560m",
  cpuShares: SERVING_CPU_SHARES,
  nodeAMaxOldSpaceSize: 1536,
  nodeBMaxOldSpaceSize: 512,
  scriptMaxOldSpaceSize: 256,
  stopTimeout: 40, // above OpenResty drain (10s) plus the app drain (25s): drained in turn
};

// The runner for heavier scripts (scripts/prod/run-script.js): its own
// container of the live image, one at a time on the host, outside the units'
// memory limits. The heap sits below the container's limit.
const SCRIPT_RUNNER = { memory: "512m", oldSpace: 384 };

// Each app container also listens on a Unix socket in this host directory,
// bind-mounted at the same path into the app containers and the proxy
// (app/helper/listen.js). Unlike the published port, a socket nobody is
// listening on refuses a connection outright, so nginx can retry the backup
// while a container drains or boots. /run is a tmpfs: the host recreates the
// directory at boot (config/host/tmpfiles.d/blot.conf) and the deploy
// ensures it exists.
const SOCKET_DIRECTORY = "/run/blot";

module.exports = {
  SOCKET_DIRECTORY,
  UNIT,
  SCRIPT_RUNNER,
  REGISTRY_URL: "ghcr.io/blotcms/blot",
  // A single 512m file only held ~6 hours of a container's logs, so the output
  // leading up to a crash-restart was usually gone by the time anyone
  // looked. Rotated files are gzipped (LOG_COMPRESS), so the extra ones
  // cost a fraction of their size on disk.
  LOG_MAX_SIZE: "512m",
  LOG_MAX_FILE: 4,
  LOG_COMPRESS: true,

  // Where each unit's Node writes a diagnostic report (JS stack,
  // heap spaces, resource usage) if it dies of a fatal error such as V8
  // running out of heap - see proxy/deploy/common.sh. Under the shared data
  // directory so reports outlive the container; app/index.js creates it.
  NODE_REPORT_DIRECTORY: "node-reports",

  // This is the directory which contains all the blog data, static
  // files, etc. It is mounted into each running container so they
  // can all access the same data.
  DATA_DIRECTORY_ON_SERVER: "/var/www/blot/data",
  DATA_DIRECTORY_ON_CONTAINER: "/usr/src/app/data",

  // Scratch space for uploads, imports and conversions (config.tmp_directory,
  // set in the container by BLOT_TMP_DIRECTORY). It is on the host's
  // ephemeral NVMe instance store, mounted at /var/instance-ssd, not the data
  // volume: nothing in it needs to outlive an instance stop/start, which wipes
  // it. The host creates it at boot (config/host/scripts/mount-instance-store.sh)
  // and it is mounted at the same path inside the containers, so the
  // instance-store disk free-disk-space.js reports there is the one tmp fills.
  TMP_DIRECTORY: "/var/instance-ssd/tmp",

  ENV_FILE_ON_SERVER: "/etc/blot/secrets.env",
};
