// Utility functions
const sshCommand = require("./util/sshCommand");
const checkBranch = require("./util/checkBranch");
const getGitCommit = require("./util/getGitCommit");
const checkHealth = require("./util/checkHealth");
const generateDockerCommand = require("./util/generateDockerCommand");
const generateAirlockCommand = require("./util/generateAirlockCommand");

const constants = require("./constants");

const { CONTAINERS, AIRLOCK } = constants;
const { REGISTRY_URL, PLATFORM_OS } = constants;

const AIRLOCK_HEALTH_CHECK_TIMEOUT = 60; // seconds
const AIRLOCK_HEALTH_CHECK_INTERVAL = 5; // seconds

const MAX_REMOTE_LOGS = 3;
let remoteTempDirPromise;

async function getRemoteTempDir() {
  // Use /tmp as the default temp directory for log archiving
  // This avoids complex shell commands that are hard to secure
  return "/tmp";
}

async function storeRemoteContainerLogs(containerName, reason) {
  // optional: validate inputs
  const safeName = (s) => {
    if (!/^[a-z0-9][a-z0-9_.-]+$/.test(s))
      throw new Error("Bad container name");
    return s;
  };
  safeName(containerName);

  const timestamp = new Date().toISOString().replace(/[:]/g, "-");
  const remoteTempDir = await getRemoteTempDir();
  const remoteDir = `${remoteTempDir}/blot-deploy-logs/${containerName}`;
  const remotePath = `${remoteDir}/${containerName}-${reason}-${timestamp}.log`;
  const tmpPath = `${remoteDir}/.${containerName}-${reason}-${timestamp}.tmp`;

  // 1) Ensure dir exists
  await sshCommand(`mkdir -p '${remoteDir}'`);

  // 2) Capture logs to a temp file (atomic move later)
  await sshCommand(
    `(docker logs '${containerName}' > '${tmpPath}' 2>&1 || true)`
  );

  // 3) Atomically move into place
  await sshCommand(`mv -f '${tmpPath}' '${remotePath}'`);

  // 4) Compute prune list on server
  const listToDelete = await sshCommand(
    `cd '${remoteDir}' && ls -1t | awk 'NR>${MAX_REMOTE_LOGS}'`
  );

  // 5) Delete old files one by one with full paths and --
  const files = listToDelete
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  for (const f of files) {
    await sshCommand(`rm -f -- '${remoteDir}/${f}'`);
  }

  // 6) Provide a fetch hint
  const fetchCommand = `scp blot:'${remotePath}' ./`;
  return { remotePath, fetchCommand };
}

async function dumpFailedContainerLogs(containerName) {
  const { remotePath, fetchCommand } = await storeRemoteContainerLogs(
    containerName,
    "fail"
  );

  console.log(`Stored failure logs on remote server: ${remotePath}`);
  console.log(`Fetch them locally with:`);
  console.log(fetchCommand);
}

async function archiveContainerLogs(containerName) {
  // Check if container exists by listing containers and checking in Node
  const containers = await sshCommand(
    `docker ps -a --format '{{.Names}}'`
  );
  
  const containerExists = containers
    .split("\n")
    .map((line) => line.trim())
    .includes(containerName);

  if (!containerExists) {
    return null;
  }

  const { remotePath, fetchCommand } = await storeRemoteContainerLogs(
    containerName,
    "deploy"
  );

  return { remotePath, fetchCommand };
}

async function detectPlatform() {
  console.log("Detecting server platform...");
  const platformOs = PLATFORM_OS;
  let platformArch = await sshCommand(
    "docker info --format '{{.Architecture}}'"
  );
  if (platformArch === "aarch64") platformArch = "arm64";
  return { platformOs, platformArch };
}

async function verifyImageManifest(commitHash, platform, registryUrl = REGISTRY_URL) {
  try {
    console.log(`Checking that an image exists (${registryUrl})...`);
    const manifest = await sshCommand(
      `docker manifest inspect ${registryUrl}:${commitHash} 2>/dev/null`
    );
    const manifestData = JSON.parse(manifest);
    return manifestData.manifests.some(
      (m) =>
        m.platform.architecture === platform.platformArch &&
        m.platform.os === platform.platformOs
    );
  } catch {
    return false;
  }
}

async function removeContainer(containerName) {
  console.log(`Removing container ${containerName}...`);
  // Check if container exists first, then remove it
  const containers = await sshCommand(
    `docker ps -a --format '{{.Names}}'`
  );
  
  const containerExists = containers
    .split("\n")
    .map((line) => line.trim())
    .includes(containerName);

  if (containerExists) {
    await sshCommand(`docker rm -f ${containerName}`);
  }
}

async function getCurrentImageHash(containerName) {
  try {
    console.log(`Getting current image hash for ${containerName}...`);
    return await sshCommand(
      `docker inspect --format='{{.Config.Image}}' ${containerName} 2>/dev/null | sed 's/.*://'`
    );
  } catch {
    return "";
  }
}

async function deployContainer(container, platform, imageHash) {
  const dockerRunCommand = await generateDockerCommand(
    container,
    platform,
    imageHash
  );

  console.log(`Deploying ${container.name}... with command:`);
  console.log();
  console.log(dockerRunCommand);
  console.log();

  console.log("Pulling new image...");
  await sshCommand(`docker pull ${REGISTRY_URL}:${imageHash}`);

  console.log("Removing running container...");
  try {
    const archivedLogsInfo = await archiveContainerLogs(
      container.name
    );

    if (archivedLogsInfo) {
      console.log(`Archived logs to ${archivedLogsInfo.remotePath}`);
      console.log(`Fetch them locally with: ${archivedLogsInfo.fetchCommand}`);
    } else {
      console.log(
        `No existing container logs to archive for ${container.name}.`
      );
    }
  } catch (logError) {
    console.warn(
      `Failed to archive logs for ${container.name}:`,
      logError.message || logError
    );
  }
  await removeContainer(container.name);
  console.log("Starting new container...");
  await sshCommand(dockerRunCommand);
  console.log("Checking health of new container...");
  await checkHealth(container.name, container.port);
}

// --- airlock (config/airlock) --------------------------------------------
//
// Deployed as a standalone container, not part of the blue/green/yellow
// rotation. Every step here is best-effort and non-fatal to the overall
// deploy: a bug deploying or connecting the airlock must not be able to
// take down blue/green/yellow. Since the cutover (BLOT_AIRLOCK_BROWSER_URL /
// PROXY_URL are set on the app containers - see generateDockerCommand.js),
// an app container that comes up without a working connection to the
// airlock will fail bookmark screenshots and remote-image downloads (both
// already degrade gracefully - the post builds without the image), but it
// still shouldn't fail the app deploy itself. config/index.js's own
// startup warning surfaces the "env vars unset" case; watch for it, and for
// "Screenshot failed after retries", in the container logs after a deploy.

async function ensureAirlockNetwork() {
  console.log(`Ensuring Docker network ${AIRLOCK.network} exists...`);
  await sshCommand(
    `docker network inspect ${AIRLOCK.network} >/dev/null 2>&1 || docker network create ${AIRLOCK.network}`
  );
}

async function checkAirlockHealth() {
  // Simpler than checkHealth.js: the airlock has no app-level /health route
  // to curl, just the container's own HEALTHCHECK (config/airlock/Dockerfile),
  // which already exercises the DevTools endpoint and the proxy internally.
  let timedout = false;

  const timeout = new Promise((_, reject) =>
    setTimeout(() => {
      timedout = true;
      reject(new Error(`Airlock health check timed out after ${AIRLOCK_HEALTH_CHECK_TIMEOUT}s`));
    }, AIRLOCK_HEALTH_CHECK_TIMEOUT * 1000)
  );

  const healthCheck = async () => {
    while (!timedout) {
      const health = await sshCommand(
        `docker inspect --format='{{.State.Health.Status}}' ${AIRLOCK.name} || echo 'unhealthy'`
      );

      if (health === "healthy") {
        console.log("Airlock is healthy.");
        return true;
      } else if (health === "starting") {
        console.log("Airlock is starting...");
        await new Promise((resolve) =>
          setTimeout(resolve, AIRLOCK_HEALTH_CHECK_INTERVAL * 1000)
        );
      } else {
        throw new Error(`Airlock health status is ${health}`);
      }
    }
  };

  return Promise.race([healthCheck(), timeout]);
}

// Running (not just present) and passing its own HEALTHCHECK. A container
// that exists with the right image tag but is stopped, crash-looping, or
// stuck "unhealthy" must NOT be mistaken for "already deployed" - Docker's
// HEALTHCHECK doesn't restart anything on its own, so if the image-hash
// skip in deployAirlockIfNeeded didn't also check this, a wedged airlock
// would never get another chance to recover until a new commit happened to
// change the image tag.
async function isAirlockHealthy() {
  try {
    const state = await sshCommand(
      `docker inspect --format='{{.State.Running}} {{.State.Health.Status}}' ${AIRLOCK.name}`
    );
    const [running, health] = state.trim().split(" ");
    return running === "true" && health === "healthy";
  } catch {
    return false;
  }
}

async function deployAirlock(platform, imageHash) {
  const dockerRunCommand = await generateAirlockCommand(platform, imageHash);

  console.log(`Deploying ${AIRLOCK.name}... with command:`);
  console.log();
  console.log(dockerRunCommand);
  console.log();

  console.log("Pulling new airlock image...");
  await sshCommand(`docker pull ${AIRLOCK.registry}:${imageHash}`);

  console.log("Removing running airlock container (if any)...");
  await removeContainer(AIRLOCK.name);

  console.log("Starting new airlock container...");
  await sshCommand(dockerRunCommand);

  console.log("Checking health of airlock container...");
  await checkAirlockHealth();
}

async function deployAirlockIfNeeded(platform, imageHash) {
  try {
    const manifestExists = await verifyImageManifest(imageHash, platform, AIRLOCK.registry);

    if (!manifestExists) {
      console.warn(
        `No airlock image for commit ${imageHash} - skipping airlock deploy this run.`
      );
      return;
    }

    await ensureAirlockNetwork();

    const currentHash = await getCurrentImageHash(AIRLOCK.name);

    if (currentHash && currentHash === imageHash && (await isAirlockHealthy())) {
      console.log("Airlock image is already deployed and healthy. Skipping...");
      return;
    }

    try {
      await deployAirlock(platform, imageHash);
    } catch (error) {
      // deployAirlock() already removed whatever was running before it
      // tried to start the replacement (same shape as deployContainer()
      // for the app containers, which has this same brief gap - mitigated
      // there by having three redundant containers, which the airlock
      // doesn't have). Roll back to the previous image so a bad airlock
      // build doesn't leave nothing running at all until a future commit
      // happens to fix it - matches the rollback main() already does for
      // blue/green/yellow.
      console.error("Airlock deploy failed:", error);

      if (currentHash && currentHash !== imageHash) {
        console.error(`Rolling back airlock to previous image ${currentHash}...`);
        try {
          await deployAirlock(platform, currentHash);
          console.error("Airlock rollback succeeded.");
        } catch (rollbackError) {
          console.error("Airlock rollback also failed - airlock is down:", rollbackError);
        }
      } else {
        console.error(
          "No different previous airlock image to roll back to - airlock is down."
        );
      }
    }
  } catch (error) {
    // Non-fatal: a problem deploying the airlock degrades bookmark
    // screenshots and remote-image downloads, but must not block or roll
    // back the app deploy itself - see the comment above this section.
    console.error("Airlock deploy step failed (continuing with app deploy):", error);
  }
}

async function connectToAirlockNetwork(containerName) {
  try {
    console.log(`Connecting ${containerName} to ${AIRLOCK.network}...`);

    // Check membership first rather than attempting the connect and
    // swallowing "already exists" with `|| true`: that would also swallow
    // every OTHER failure (missing network, missing container, ...),
    // meaning a genuine attach failure logged nothing and looked identical
    // to success in the deploy log - discoverable only much later, when
    // screenshots/downloads on that container start failing. A real
    // failure here now propagates to the catch below instead of being
    // hidden.
    const members = await sshCommand(
      `docker network inspect ${AIRLOCK.network} --format='{{range .Containers}}{{.Name}} {{end}}'`
    );

    if (members.split(/\s+/).includes(containerName)) {
      console.log(`${containerName} is already connected to ${AIRLOCK.network}.`);
      return;
    }

    await sshCommand(`docker network connect ${AIRLOCK.network} ${containerName}`);
  } catch (error) {
    // Non-fatal - see the comment above deployAirlockIfNeeded.
    console.error(`Failed to connect ${containerName} to ${AIRLOCK.network}:`, error);
  }
}

async function main() {
  try {
    // Validate arguments
    if (process.argv.length > 3) {
      throw new Error("Too many arguments provided.");
    }

    console.log(
      "When running a deployment, it's helpful to ssh into the server and run in two seperate windows"
    );
    console.log("See live overview of docker containers:");
    console.log("watch 'docker ps' ");
    console.log(
      "Watch traffic to backup servers (ideally this should not happen during deployment):"
    );
    console.log("backup-servers");

    await checkBranch();

    const { commitHash, commitMessage } = await getGitCommit(process.argv[2]);

    console.log(`Deploying image for commit: ${commitHash} - ${commitMessage}`);

    const imageHash = commitHash;
    const platform = await detectPlatform();
    const manifestExists = await verifyImageManifest(imageHash, platform);

    if (!manifestExists) {
      throw new Error(
        `Image for platform ${platform.platformOs}/${platform.platformArch} does not exist.`
      );
    }

    // Deploy/update the airlock ahead of the app containers, so that once
    // they're connected to its network below it's already up. Entirely
    // best-effort - see the comment above deployAirlockIfNeeded.
    await deployAirlockIfNeeded(platform, imageHash);

    // const askForConfirmation = require("./util/askForConfirmation");
    // const confirmed = await askForConfirmation(
    //   "Are you sure you want to deploy this image? (y/n): "
    // );

    // if (!confirmed) {
    //   console.log("Deployment canceled.");
    //   process.exit(0);
    // }

    // validate that each container has a unique name and port
    const containerNames = Object.values(CONTAINERS).map(
      (container) => container.name
    );
    const uniqueContainerNames = new Set(containerNames);
    if (containerNames.length !== uniqueContainerNames.size) {
      throw new Error("Container names must be unique.");
    }

    const containerPorts = Object.values(CONTAINERS).map(
      (container) => container.port
    );
    const uniqueContainerPorts = new Set(containerPorts);
    if (containerPorts.length !== uniqueContainerPorts.size) {
      throw new Error("Container ports must be unique.");
    }

    console.log("Deploying containers...");
    // Deploy all containers
    for (const container of Object.values(CONTAINERS)) {
      const rollbackHash = await getCurrentImageHash(container.name);

      if (rollbackHash && rollbackHash === imageHash) {
        console.log(
          `Image for ${container.name} is already deployed. Skipping...`
        );
        // Still ensure the network hookup exists even when we skip
        // redeploying the container itself (e.g. a re-run of this script).
        await connectToAirlockNetwork(container.name);
        continue;
      }

      if (rollbackHash) {
        console.log("Determined rollback hash:", rollbackHash);
      } else {
        console.log("No previous image found for rollback.");
      }

      try {
        await deployContainer(container, platform, imageHash);
        await connectToAirlockNetwork(container.name);
      } catch (error) {
        console.error(`Deployment failed for ${container.name}`);

        try {
          await dumpFailedContainerLogs(container.name);
        } catch (logError) {
          console.warn(
            `Failed to collect logs for ${container.name}:`,
            logError
          );
        }

        if (!rollbackHash) {
          console.error("No previous image to rollback to. Exiting...");
          throw error;
        }

        console.error("Rolling back...");
        try {
          await deployContainer(container, platform, rollbackHash);
          await connectToAirlockNetwork(container.name);
          console.error("Rollback succeeded.");
        } catch (rollbackError) {
          console.error("Rollback failed:", rollbackError);
        }
        throw error;
      }
    }

    console.log("Pruning old images...");
    const pruned = await sshCommand("docker image prune -af");
    console.log(pruned);
    console.log("Deployment completed successfully!");
    process.exit(0);
  } catch (error) {
    console.error("Deployment failed:", error);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  dumpFailedContainerLogs,
  archiveContainerLogs,
  deployContainer,
  deployAirlockIfNeeded,
  connectToAirlockNetwork,
  main,
};
