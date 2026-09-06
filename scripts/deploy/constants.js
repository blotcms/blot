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

module.exports = {
  REGISTRY_URL: "ghcr.io/davidmerfield/blot",
  PLATFORM_OS: "linux",
  LOG_MAX_SIZE: "512m",
  LOG_MAX_FILE: 1,

  // This is the port each container listens on internally
  // Externally they listen on the port specified in the container
  // configuration and our reverse proxy load balances between them.
  INTERNAL_PORT: 8080,

  // This is the directory which contains all the blog data, static
  // files, etc. It is mounted into each running container so they
  // can all access the same data.
  DATA_DIRECTORY_ON_SERVER: "/var/www/blot/data",
  DATA_DIRECTORY_ON_CONTAINER: "/usr/src/app/data",

  ENV_FILE_ON_SERVER: "/etc/blot/secrets.env",

  // The airlock container (config/airlock) - the egress boundary for
  // fetching untrusted, user-supplied URLs. See config/airlock/README.md.
  //
  // Deployed as a single, standalone container - not blue/green/yellow -
  // on its own Docker network. App containers are NOT switched onto this
  // network at creation (that would move their default gateway off the
  // bridge they're on today - see config/airlock/README.md's production
  // note); instead the deploy script `docker network connect`s each app
  // container to it after it starts, so they keep their original network
  // and gain a second interface that can reach `blot-airlock`.
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
    registry: "ghcr.io/davidmerfield/blot-airlock",
    network: "blotnet",
    memory: "512m",
    cpus: 1,
  },

  CONTAINERS: {
    // Failover server (both sites and blogs)
    BLUE: {
      name: "blot-container-blue",
      port: 8088,
      ...siteConfig,
    },

    // Site server (dashboard, brochure, sync folders)
    GREEN: {
      name: "blot-container-green",
      port: 8089,
      ...siteConfig,
    },

    // Blog server (previews, published blogs)
    YELLOW: {
      name: "blot-container-yellow",
      port: 8090,
      ...blogsConfig,
    },
  },
};
