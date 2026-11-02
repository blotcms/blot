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
//   node-a   the blog container's heap (1500) plus room for dashboard reads
//   node-b   the sync container's heap, with the same overhead it had for
//            pandoc and esbuild (the browser runs in the sandbox)
//   memory   both heaps plus 750m for everything else: OpenResty's workers,
//            V8's overhead, pandoc, git and esbuild. Sized to fit beside Redis
//            on one host (#2261): two units, their sandbox cgroups (outside
//            this limit: config/host/host/setup.sh) and Redis's maxmemory and
//            fork overhead come to under 14 GiB of 16. Page cache counts
//            against this too, but it is reclaimed, so what matters is the
//            memory that can't be (unit-mem-summary.sh on the host)
// The heaps are ceilings, not reservations: V8 uses what the render caches
// and requests need, and the unit's cgroup limit sits above both so a runaway
// heap dies with a diagnostic report rather than to the OOM killer.
// cpus overcommits slightly.
const UNIT = {
  cpus: 4,
  memory: "3300m",
  cpuShares: SERVING_CPU_SHARES,
  nodeAMaxOldSpaceSize: 1800,
  nodeBMaxOldSpaceSize: 750,
  stopTimeout: 40, // above OpenResty drain (10s) plus the app drain (25s): drained in turn
};

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

  // The sandbox's proxy jail in each unit (proxy/unit/sandbox/proxy.js), the
  // egress boundary for fetching untrusted, user-supplied URLs since the
  // airlock went (#2257). It listens on the host's loopback at a port per
  // unit: units share the host network, so the two must differ. Screenshots
  // run in the sandbox's browser jail and need no port.
  SANDBOX: {
    units: {
      blue: { proxyPort: 18988 },
      green: { proxyPort: 18989 },
    },
  },
};
