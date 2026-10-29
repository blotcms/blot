const fs = require("fs");
const config = require("config");
const clfdate = require("helper/clfdate");
const email = require("helper/email");
const redis = require("models/client");
const { isRedisUnavailableError } = require("helper/redisUnavailable");
const setup = require("./setup");
const server = require("./server");
const drain = require("helper/drain");
const listen = require("helper/listen");
const workerChild = require("helper/workerChild");

const DEPLOYMENT_MARKER_EXPIRATION_SECONDS = 90 * 24 * 60 * 60;
const REQUEST_TIMEOUT_MS = 60 * 60 * 1000;
const KEEP_ALIVE_TIMEOUT_MS = 65 * 1000;

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

// The worker child sends no start email of its own, so this process sends
// one when the child dies and is forked again, at most every ten minutes so a
// crash loop sends one rather than one per restart
function workerExitEmail() {
  const label = config.container.endsWith("/node-a")
    ? config.container.slice(0, -1) + "b"
    : config.container + "-worker";
  let lastSent = 0;

  return function (reason) {
    if (config.preview || Date.now() - lastSent < 10 * 60 * 1000) return;
    lastSent = Date.now();
    email.SERVER_START(null, {
      container: label,
      event: "restarted (" + reason + ")",
    });
  };
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

// Installed before setup so a SIGTERM during startup also exits cleanly
drain.install();

if (config.worker_child) {
  // Under memory pressure the kernel should kill this worker, not the web
  // process that forked it (and would fork it again). Raising our own score
  // needs no privilege; outside Linux there is no such file.
  try {
    fs.writeFileSync("/proc/self/oom_score_adj", "1000");
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.error(clfdate(), "Could not raise oom_score_adj", err.message);
    }
  }

  // The parent is gone (it crashed or was killed), so nothing will restart
  // or stop us: drain and exit rather than linger without it
  process.on("disconnect", function () {
    console.log(clfdate(), "[WORKER] Parent disconnected, draining");
    drain.start().then(
      () => process.exit(0),
      () => process.exit(1)
    );
  });
}

console.log(clfdate(), `Starting server env=${config.environment}`);
setup(async (err) => {
  if (err) throw err;

  console.log(clfdate(), "Finished setting up server");

  // Applied to both the TCP and the Unix socket server.
  const configure = (server) => {
    // Node's default requestTimeout (300s) answers 408 to any request whose whole
    // request, body included, takes longer than that to arrive. A large git push
    // over a slow connection does (a ~700 MB push at 2 MB/s needs ~350s), so it
    // was cut off while it was still making progress. nginx is in front of every
    // request (10s header and body timeouts, 60s for git, and a body size cap),
    // so a stalled or oversized request never gets this far; this only ends
    // uploads which are still progressing, and an hour is long enough for one.
    // It applies to every upload, the dashboard's too. headersTimeout is left
    // alone.
    server.requestTimeout = REQUEST_TIMEOUT_MS;

    // nginx keeps an idle upstream connection for 60s (its default
    // keepalive_timeout) but Node closes one after 5s, so nginx kept reopening
    // connections and could send a request on a socket Node was closing, which
    // fails as a 502 or a retry to the backup. Outlasting nginx means nginx is
    // always the side that closes an idle connection.
    server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
  };

  // A forked worker serves on its socket alone: the parent has the port
  const options = {
    port: config.worker_child ? null : config.port,
    socket: config.socket,
    configure,
  };

  // Open the server to handle requests
  const httpServers = listen(server, options, function () {
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

    // A process given a socket for one forks a worker child and keeps it
    // running, and stops it when draining (see helper/workerChild)
    // (not when a SIGTERM during startup has begun the drain already)
    if (config.worker_socket && !config.worker_child && !drain.isDraining()) {
      const worker = workerChild({
        script: __filename,
        socket: config.worker_socket,
        maxOldSpaceSize: config.worker_max_old_space_size,
        drainTimeoutMs: drain.DRAIN_TIMEOUT_MS,
        onExit: workerExitEmail(),
      });
      drain.onStart(() => worker.stop());
    }

    // Send an email notification if the server starts or restarts
    // Worktree preview sidecars (scripts/development/preview.sh) and forked
    // workers (their parent emails when one dies: workerExitEmail) skip it
    if (!config.preview && !config.worker_child) {
      serverStartEvent().then((event) =>
        email.SERVER_START(null, { container: config.container, event })
      );
    }
  });

  httpServers.forEach((s) => drain.setServer(s));
});
