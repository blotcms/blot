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
const flush = require("documentation/tools/flush-cache");
const configureLocalBlogs = require("./configure-local-blogs");
const purgeCdnUrls = require("helper/purgeCdnUrls");

const log = (...args) =>
  console.log.apply(null, [clfdate(), "Setup:", ...args]);

async function runPostListenTasks() {
  log("Running post-listen tasks asynchronously");
  const logError = (message, error) => {
    console.error(clfdate(), "Setup:", message, error || "");
  };

  let templatesBuilt = false;

  if (config.master) {
    log("Building templates after listen");
    try {
      await new Promise((resolve, reject) => {
        templates(
          { watch: config.environment === "development" },
          (err) => (err ? reject(err) : resolve())
        );
      });
      templatesBuilt = true;
      log("Built templates after listen");
    } catch (err) {
      logError("Failed to build templates after listen", err);
    }
  } else {
    log("Skipping template build after listen (not master)");
  }

  try {
    // Each application process owns an independent client-side Redis cache.
    log("Starting Redis cache stats logging asynchronously");
    setInterval(logRedisCacheStats, 60 * 1000);
  } catch (err) {
    logError("Failed to start Redis cache stats logging", err);
  }

  try {
    if (config.master) {
      log("Starting scheduler asynchronously");
      scheduler();
    }
  } catch (err) {
    logError("Failed to start scheduler", err);
  }

  try {
    if (config.master) {
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

  if (config.master && config.environment === "production") {
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
      async function () {
        const featuredDir = path.join(config.data_directory, "featured");
        const featuredFile = path.join(featuredDir, "featured.json");

        log("Clearing featured cache file");
        await fs.ensureDir(featuredDir);
        await fs.remove(featuredFile);
        log("Cleared featured cache file");
      },

      async function () {
        log("Creating required directories");
        await fs.ensureDir(config.blog_folder_dir);
        await fs.ensureDir(config.blog_static_files_dir);
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
          try {
            await client.mSetNX({
              ["domain:" + config.host]: "X",
              ["domain:www." + config.host]: "X",
            });
          } catch (err) {
            console.error(
              "Unable to set domain flag for host" +
                config.host +
                ". SSL may not work on site."
            );
            console.error(err);
          }

          log("Created SSL key for redis");
          callback();
        })();
      },

      function (callback) {
        if (config.master) {
          log("Deferring template build until after listen");
        } else {
          log("Skipping template build (not master)");
        }
        callback();
      },

      async function () {
        // The docker build stage for production runs this script ahead of time
        if (config.environment !== "development") return;
        await documentation({ watch: true });
      },

    ],
    callback
  );
}

main.runPostListenTasks = runPostListenTasks;

module.exports = main;
