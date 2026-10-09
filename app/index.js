const fs = require("fs");
const config = require("config");
const clfdate = require("helper/clfdate");
const email = require("helper/email");
const redis = require("models/client");
const { isRedisUnavailableError } = require("helper/redisUnavailable");
const setup = require("./setup");
const server = require("./server");

const DEPLOYMENT_MARKER_EXPIRATION_SECONDS = 90 * 24 * 60 * 60;
const REQUEST_TIMEOUT_MS = 60 * 60 * 1000;

// The deploy sets --report-on-fatalerror (scripts/deploy/util/
// generateDockerCommand.js), but Node won't create the report directory
// itself, and a missing one means a V8 out-of-memory crash leaves no report.
if (process.report && process.report.reportOnFatalError && process.report.directory) {
  try {
    fs.mkdirSync(process.report.directory, { recursive: true });
  } catch (err) {
    console.error(clfdate(), "Could not create Node report directory", err);
  }
}

// Background work that hits Redis while it is down rejects with a connection
// error. Log those rather than crash the process. Installing a listener
// disables Node's default handling, so anything else is rethrown, which
// surfaces as an uncaught exception and still exits the process.
process.on("unhandledRejection", function (err) {
  if (!isRedisUnavailableError(err)) throw err;
  console.error(clfdate(), "Unhandled rejection (Redis unavailable):", err.message);
});

function releaseId() {
  return process.env.BLOT_RELEASE_ID || process.env.GIT_SHA;
}

async function serverStartEvent() {
  const id = releaseId();

  if (!id) return "started";

  const key = `server:start-notification:${config.container}:${id}`;

  try {
    // The deploy script passes the image commit hash as BLOT_RELEASE_ID; GIT_SHA
    // is a fallback for other runtimes. Markers expire after 90 days to bound
    // Redis key growth.
    const result = await redis.set(key, "1", {
      NX: true,
      EX: DEPLOYMENT_MARKER_EXPIRATION_SECONDS,
    });

    return result === "OK" ? "deployed" : "restarted";
  } catch (err) {
    console.error(clfdate(), "Could not determine server start event", err);
    return "started";
  }
}

console.log(clfdate(), `Starting server env=${config.environment}`);
setup(async (err) => {
  if (err) throw err;

  console.log(clfdate(), "Finished setting up server");

  // Open the server to handle requests
  const httpServer = server.listen(config.port, function () {
    console.log(clfdate(), `Server listening`);

    // Run non-blocking setup tasks after the port is bound so startup isn't delayed.
    if (typeof setup.runPostListenTasks === "function") {
      setup
        .runPostListenTasks()
        .catch((err) =>
          console.error(
            clfdate(),
            "Setup:",
            "Post-listen tasks encountered an error",
            err
          )
        );
    }

    // Send an email notification if the server starts or restarts
    // Worktree preview sidecars (scripts/development/preview.sh) are not master
    if (config.master || config.environment !== "development") {
      serverStartEvent().then((event) =>
        email.SERVER_START(null, { container: config.container, event })
      );
    }
  });

  // Node's default requestTimeout (300s) answers 408 to any request whose whole
  // request, body included, takes longer than that to arrive. A large git push
  // over a slow connection does (a ~700 MB push at 2 MB/s needs ~350s), so it
  // was cut off while it was still making progress. nginx is in front of every
  // request (10s header and body timeouts, 60s for git, and a body size cap),
  // so a stalled or oversized request never gets this far; this only ends
  // uploads which are still progressing, and an hour is long enough for one.
  // It applies to every upload, the dashboard's too. headersTimeout is left
  // alone.
  httpServer.requestTimeout = REQUEST_TIMEOUT_MS;
});
