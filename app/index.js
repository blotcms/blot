const config = require("config");
const clfdate = require("helper/clfdate");
const email = require("helper/email");
const redis = require("models/client");
const setup = require("./setup");
const server = require("./server");

const DEPLOYMENT_MARKER_EXPIRATION_SECONDS = 90 * 24 * 60 * 60;

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
  server.listen(config.port, function () {
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
    serverStartEvent().then((event) =>
      email.SERVER_START(null, { container: config.container, event })
    );
  });
});
