const config = require("config");
const fs = require("fs-extra");
const path = require("path");

const client = require("models/client");
const documentation = require("./documentation/build");
const templates = require("./templates");
const folders = require("./templates/folders");
const async = require("async");
const clfdate = require("helper/clfdate");
const scheduler = require("./scheduler");
const logRedisCacheStats = require("./scheduler/redis-cache-stats");
const logRenderCacheStats = require("./scheduler/render-cache-stats");
const renderTimeMetric = require("./blog/render/renderTimeMetric");
const flush = require("documentation/tools/flush-cache");
const configureLocalBlogs = require("./configure-local-blogs");
const purgeCdnUrls = require("helper/purgeCdnUrls");
const { assertConfigured: assertStorageBucket } = require("storage/s3");

// The offline queue is still on while we boot, so a command sent while Redis
// is unreachable waits for the connection instead of failing. Don't let that
// stop the server from listening.
const REDIS_BOOT_TIMEOUT_MS = 10 * 1000;

const log = (...args) =>
  console.log.apply(null, [clfdate(), "Setup:", ...args]);

async function runPostListenTasks() {
  log("Running post-listen tasks asynchronously");
  const logError = (message, error) => {
    console.error(clfdate(), "Setup:", message, error || "");
  };

  let templatesBuilt = false;

  // Every process builds templates: the build takes a Redis lock and the
  // losers find nothing to change. In development, preview slots overwrite
  // the shared dev templates with their worktree's copy.
  log("Building templates after listen");
  try {
    await new Promise((resolve, reject) => {
      templates({ watch: config.environment === "development" }, (err) =>
        err ? reject(err) : resolve()
      );
    });
    templatesBuilt = true;
    log("Built templates after listen");
  } catch (err) {
    logError("Failed to build templates after listen", err);
  }

  try {
    // Each application process owns an independent client-side Redis cache.
    log("Starting Redis cache stats logging asynchronously");
    setInterval(logRedisCacheStats, 60 * 1000);
  } catch (err) {
    logError("Failed to start Redis cache stats logging", err);
  }

  try {
    // Process memory plus the render-path in-process LRU caches, so heap
    // growth can be correlated against cache footprint after the fact.
    log("Starting render cache stats logging asynchronously");
    setInterval(logRenderCacheStats, 60 * 1000);
  } catch (err) {
    logError("Failed to start render cache stats logging", err);
  }

  try {
    log("Starting event loop monitor");
    require("helper/eventLoopMonitor").start();
  } catch (err) {
    logError("Failed to start event loop monitor", err);
  }

  try {
    // Every container renders customer pages, so every container flushes
    // its own p95 window to Redis for the daily update email to read back.
    log("Starting render time metric flushing asynchronously");
    renderTimeMetric.start();
  } catch (err) {
    logError("Failed to start render time metric flushing", err);
  }

  try {
    // Every container polls for scheduled entries that have come due
    log("Starting scheduled entry publication asynchronously");
    const { alarm } = require("models/entry/scheduled");
    alarm.start();
    // Claim nothing new once draining; an unfinished one is retried elsewhere
    require("helper/drain").onStart(() => {
      alarm.stop().catch((err) => logError("Failed to stop scheduled entry publication", err));
    });
  } catch (err) {
    logError("Failed to start scheduled entry publication", err);
  }

  try {
    // Any container may claim a due alarm, so every container polls
    log("Starting welcome email alarm");
    const welcomeEmailAlarm = require("models/user/scheduleWelcomeEmail").alarm;
    welcomeEmailAlarm.start();
    require("helper/drain").onStart(() => welcomeEmailAlarm.stop());
  } catch (err) {
    logError("Failed to start welcome email alarm", err);
  }

  try {
    // Webhooks that arrived while their blog was syncing leave a follow-up
    // sync which any container may run. Previews share the dev Redis and skip
    // them, as they skip the clients.
    if (!config.preview) {
      log("Starting follow-up syncs");
      const followUpSync = require("clients/util/followUpSync");
      // Loads each client's routes, which create their follow-up syncs
      require("clients");
      followUpSync.startAll();
      require("helper/drain").onStart(() => {
        followUpSync.stopAll().catch((err) => logError("Failed to stop follow-up syncs", err));
      });
    }
  } catch (err) {
    logError("Failed to start follow-up syncs", err);
  }

  // Cron jobs and client jobs take Redis locks, so every container runs them.
  // Worktree previews share the dev Redis and skip them.
  try {
    if (!config.preview) {
      log("Starting scheduler asynchronously");
      scheduler();
    }
  } catch (err) {
    logError("Failed to start scheduler", err);
  }

  try {
    if (!config.preview) {
      const clients = Object.values(require("clients"));
      for (const { init, display_name } of clients) {
        if (init) {
          console.log(
            clfdate(),
            display_name + " client:",
            "Initializing asynchronously"
          );
          try {
            init();
          } catch (err) {
            logError(`Error initializing ${display_name} client`, err);
          }
        }
      }
    }
  } catch (err) {
    logError("Failed while initializing clients", err);
  }

  // A forked worker child (helper/workerChild) leaves the rest to its parent,
  // which has done it already: a child crash-looping on restart would
  // otherwise flush the proxy caches and call Bunny each time
  if (config.worker_child) return;

  try {
    if (templatesBuilt) {
      log("Flushing caches after template rebuild");
    } else {
      log("Flushing caches asynchronously");
    }
    flush();
  } catch (err) {
    logError("Failed to flush caches", err);
  }

  try {
    if (config.environment === "development") {
      log("Configuring local blogs asynchronously");
      configureLocalBlogs();
    }
  } catch (err) {
    logError("Failed to configure local blogs", err);
  }

  if (config.environment === "production") {
    log("Building folders asynchronously");

    setImmediate(async () => {
      try {
        await folders();
        log("Built folders asynchronously");
      } catch (err) {
        logError("Error building folders", err);
      }
    });
  }

  try {
    const cdnURL = require("documentation/tools/cdn-url-helper")({
      cacheID: new Date().getTime(),
      viewDirectory: config.views_directory,
    })();

    const urls = [
      "/dashboard.min.css",
      "/dashboard.min.js",
      "/documentation.min.css",
      "/documentation.min.js",
    ].map((path) => cdnURL(path, (p) => p));

    await purgeCdnUrls(urls);
  } catch (err) {
    logError("Failed to run function to purge Bunny CDN cache", err);
  }
}

function main(callback) {
  async.series(
    [
      function (callback) {
        // Generated assets live only in the storage bucket: without one every
        // build and upload would fail, so refuse to start
        try {
          assertStorageBucket();
        } catch (err) {
          return callback(err);
        }

        callback();
      },

      async function () {
        // The parent of a forked worker child has cleared it
        if (config.worker_child) return;

        // In development, drop the cached copy so edits to the seed list show.
        if (config.environment === "development") {
          await fs.remove(path.join(config.data_directory, "featured", "featured.json"));
          return;
        }

        // Elsewhere keep the previously filtered featured.json rather than
        // clearing it: the seed list is unfiltered, so sites that have since
        // left Blot ('your domain is almost set up') would show until the
        // filter finished. Re-filter from the seed in the background.

        log("Refreshing featured sites in the background");
        require("documentation/featured/check")()
          .then(() => log("Refreshed featured sites"))
          .catch((err) => log("Error refreshing featured sites", err));
      },

      async function () {
        log("Creating required directories");
        await fs.ensureDir(config.blog_folder_dir);
        await fs.ensureDir(config.log_directory);
        await fs.ensureDir(config.tmp_directory);
        log("Created required directories");
      },

      function (callback) {
        // Blot's SSL certificate system requires the existence
        // of the domain key in redis. See config/nginx/auto-ssl.conf
        // for more information about the specific implementation.
        // Anyway, so that the homepage. We redirect the 'www' subdomain
        // to the apex domain, but we need to generate a cert to do this.
        // Typically, domain keys like domain:example.com store a blog's ID
        // but since the homepage is not a blog, we just use a placeholder 'X'
        log("Creating SSL key for redis");
        (async function () {
          let timer;
          try {
            await Promise.race([
              client.mSetNX({
                ["domain:" + config.host]: "X",
                ["domain:www." + config.host]: "X",
              }),
              new Promise(function (resolve, reject) {
                // By now models/redis has stopped the client queueing, so
                // requests served from here on fail fast with a 503
                timer = setTimeout(function () {
                  reject(new Error("Timed out waiting for Redis"));
                }, REDIS_BOOT_TIMEOUT_MS);
              }),
            ]);
          } catch (err) {
            console.error(
              "Unable to set domain flag for host" +
                config.host +
                ". SSL may not work on site."
            );
            console.error(err);
          } finally {
            clearTimeout(timer);
          }

          log("Created SSL key for redis");
          callback();
        })();
      },

      async function () {
        // The docker build stage for production runs this script ahead of time
        if (config.environment !== "development") return;
        log("Building documentation assets");
        await documentation({ watch: true });
        log("Built documentation assets");
      },

    ],
    callback
  );
}

main.runPostListenTasks = runPostListenTasks;

module.exports = main;
