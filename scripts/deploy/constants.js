// N.B. The image deployed should be capable of serving both
// sites and blogs. The difference in configuration is in the
// number of cpus, memory, and maxOldSpaceSize only.

// We need more overhead between maxOldSpaceSize and memory
// for the site servers because they need to run chromium
// and pandoc for building posts. The blog servers don't.
//
// The airlock sidecar (AIRLOCK.memory below) is paid for out of these
// three, not on top of them, so the host's total stays where it was:
// 512m for the airlock, taken as ~512/3 off each of the app containers.
// The overhead between memory and maxOldSpaceSize shrinks by that ~170m -
// still ample for the site servers today, and the chromium half of what it
// covers moves out to the airlock entirely at the traffic cutover, so it
// can come down further then. Watch `docker stats` after the first deploy;
// if a container is tight, restore its memory and take more from the
// others (yellow has the least headroom to give).
const siteConfig = {
  cpus: 2, // we overcommit cpu slightly
  memory: "1365m", // 1.5g - 512/3, see the airlock note above
  maxOldSpaceSize: 750,
};

// The blog servers only have a single node.js process and
// also the esbuild process which is much lighter so the
// gap between memory and maxOldSpaceSize can be smaller.
const blogsConfig = {
  cpus: 2,
  memory: "1878m", // 2g - 512/3, see the airlock note above
  maxOldSpaceSize: 1500,
};

// CPU weights (docker --cpu-shares), set per container in CONTAINERS below.
// Docker's default weight is 1024. Shares only matter when the host's CPUs
// are contended - they decide who gets the CPU when there isn't enough to
// go around - so green can still use its full `cpus` quota whenever the box
// is idle. Under contention blog serving (yellow) and dashboard reads (blue)
// get ~4x green's CPU time. Green holds the background work - entry builds,
// syncs, webhooks and the scheduler - but also takes the dashboard writes,
// so dashboard POSTs are deprioritised along with it. That is accepted: a
// slightly slower save is better than a slow blog.
const SERVING_CPU_SHARES = 2048;
const BACKGROUND_CPU_SHARES = 512;

// The two units (#2119): blot-blue and blot-green, each one container holding
// OpenResty, node-a (blogs, dashboard reads) and node-b (the worker child:
// webhooks, /clients, dashboard writes), deployed by proxy/deploy/blue-green.sh
// (via ./units.sh). It gets these through ./unit-settings.js.
//
// One unit must be able to carry all the traffic on its own while the other is
// being replaced, so each is sized for everything today's three Node
// containers do, not a third of it:
//   node-a   yellow's heap (1500) plus room for blue's dashboard reads
//   node-b   green's heap, with the same overhead green had for pandoc and
//            esbuild (the browser moved to the airlock)
//   memory   node-a's heap plus yellow's overhead (378m), node-b's heap plus
//            green's overhead (615m), and room for OpenResty's workers
// The heaps are ceilings, not reservations: V8 uses what the render caches
// and requests need, and the unit's cgroup limit sits above both so a runaway
// heap dies with a diagnostic report rather than to the OOM killer.
// cpus overcommits slightly, as the three containers' 2 each did. Each unit
// has its own airlock (AIRLOCK below), paid for separately.
const UNIT = {
  cpus: 4,
  memory: "3840m",
  cpuShares: SERVING_CPU_SHARES,
  nodeAMaxOldSpaceSize: 1800,
  nodeBMaxOldSpaceSize: 750,
  stopTimeout: 30, // above the app's drain timeout (app/helper/drain.js)
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
  PLATFORM_OS: "linux",
  // A single 512m file only held ~6 hours of yellow's logs, so the output
  // leading up to a crash-restart was usually gone by the time anyone
  // looked. Rotated files are gzipped (LOG_COMPRESS), so the extra ones
  // cost a fraction of their size on disk.
  LOG_MAX_SIZE: "512m",
  LOG_MAX_FILE: 4,
  LOG_COMPRESS: true,

  // Where each app container's Node writes a diagnostic report (JS stack,
  // heap spaces, resource usage) if it dies of a fatal error such as V8
  // running out of heap - see generateDockerCommand. Under the shared data
  // directory so reports outlive the container; app/index.js creates it.
  NODE_REPORT_DIRECTORY: "node-reports",

  // This is the port each container listens on internally
  // Externally they listen on the port specified in the container
  // configuration and our reverse proxy load balances between them.
  INTERNAL_PORT: 8080,

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

  // The airlock container (config/airlock) - the egress boundary for
  // fetching untrusted, user-supplied URLs. See config/airlock/README.md.
  //
  // Deployed as a single, standalone container - not blue/green/yellow -
  // on its own Docker network. App containers are NOT given `--network
  // blotnet` at `docker create` (that would move their default gateway off
  // the bridge they're on today - see config/airlock/README.md's production
  // note); instead the deploy script `docker network connect`s each app
  // container to it between `docker create` and `docker start`, so they keep
  // their original bridge network and gateway and gain a second interface
  // that can reach `blot-airlock`. Attaching the network before start (not
  // after, as originally written) matters: connecting a network to an
  // already-running container drops its in-flight connections - it was
  // killing the app's established connections to the off-box Redis instance
  // seconds after each deploy, one crash-restart per container.
  //
  // memory is deliberately tight. Idle (nginx + tinyproxy + a headless
  // Chromium with no page open) this sits under ~300m; it held up in
  // testing to three back-to-back full 1200x1200 @2x screenshots with no
  // OOM. Real bookmark-screenshot rendering and remote-image downloads run
  // here now (config.airlock), serialized across the app containers by the
  // lock in app/helper/screenshot, so concurrent load on it stays low. This
  // 512m is taken out of siteConfig/blogsConfig above, not added on top -
  // see the note there; the app containers can shed more of their own
  // Chromium overhead once the follow-up PR drops that binary.
  AIRLOCK: {
    name: "blot-airlock",
    registry: "ghcr.io/blotcms/blot-airlock",
    network: "blotnet",
    memory: "512m",
    cpus: 1,
    // Screenshots and remote downloads for entry builds - background work,
    // weighted like green (see the CPU weights note above).
    cpuShares: BACKGROUND_CPU_SHARES,

    // One airlock per unit (#2119), deployed with it as blot-<unit>-airlock.
    // A unit runs on the host network and cannot join blotnet or resolve
    // names on it, so each airlock publishes its two ports on 127.0.0.1
    // only, at a distinct host port per unit, and the unit is given those
    // URLs. The ports are well clear of 8088-8090, which the old containers
    // hold during the cutover. The egress filter (config/airlock/egress.nft)
    // is in the airlock's own network namespace, so it does not depend on
    // how its clients reach it. See config/airlock/README.md.
    units: {
      blue: { name: "blot-blue-airlock", browserPort: 19222, proxyPort: 18888 },
      green: { name: "blot-green-airlock", browserPort: 19223, proxyPort: 18889 },
    },
  },

  CONTAINERS: {
    // Failover server (both sites and blogs). Deployed first, so it is also
    // the canary for the rest of the deploy: `verify` runs the deploy-time
    // checks in ../verify-container inside it once it is healthy, and a
    // failure rolls it back before green and yellow are touched.
    BLUE: {
      name: "blot-container-blue",
      socket: `${SOCKET_DIRECTORY}/blue.sock`,
      port: 8088,
      verify: true,
      ...siteConfig,
      cpuShares: SERVING_CPU_SHARES,
    },

    // Site server (dashboard, brochure, sync folders)
    GREEN: {
      name: "blot-container-green",
      socket: `${SOCKET_DIRECTORY}/green.sock`,
      port: 8089,
      ...siteConfig,
      cpuShares: BACKGROUND_CPU_SHARES,
    },

    // Blog server (previews, published blogs)
    YELLOW: {
      name: "blot-container-yellow",
      socket: `${SOCKET_DIRECTORY}/yellow.sock`,
      port: 8090,
      ...blogsConfig,
      cpuShares: SERVING_CPU_SHARES,
    },
  },
};
