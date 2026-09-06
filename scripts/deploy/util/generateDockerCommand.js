const CONSTANTS = require("../constants");

const sshCommand = require("./sshCommand");

const { INTERNAL_PORT } = CONSTANTS;
const { DATA_DIRECTORY_ON_SERVER } = CONSTANTS;
const { DATA_DIRECTORY_ON_CONTAINER } = CONSTANTS;
const { ENV_FILE_ON_SERVER } = CONSTANTS;
const { REGISTRY_URL } = CONSTANTS;
const { LOG_MAX_SIZE, LOG_MAX_FILE } = CONSTANTS;
const { AIRLOCK } = CONSTANTS;

const VALID_PLATFORMS = {
  linux: ["amd64", "arm64"],
};

const MIN_PORT = 1024;
const MAX_PORT = 65535;
const MIN_CPUS = 0.1;
const MAX_CPUS = 32;
const MIN_MEMORY_MB = 32;
const MAX_MEMORY_MB = 1024 * 128; // 128GB
const MIN_OLD_SPACE_SIZE = 512;
const MAX_OLD_SPACE_SIZE = 32768; // 32GB

let validatedConstants = false;

async function validateConstants() {
  if (validatedConstants) {
    console.log("Constants already validated");
    return;
  }

  console.log("Validating constants...");

  // Validate INTERNAL_PORT
  if (!INTERNAL_PORT || typeof INTERNAL_PORT !== "number") {
    throw new Error(
      `INTERNAL_PORT must be a number between ${MIN_PORT} and ${MAX_PORT}`
    );
  }

  // Validate REGISTRY_URL
  const registryUrlPattern =
    /^([a-zA-Z0-9-]+\.)*[a-zA-Z0-9-]+(\.[a-zA-Z]{2,})(:[0-9]+)?\/[a-zA-Z0-9/_-]+$/;

  if (
    !REGISTRY_URL ||
    typeof REGISTRY_URL !== "string" ||
    !registryUrlPattern.test(REGISTRY_URL)
  ) {
    throw new Error("REGISTRY_URL must be a non-empty string");
  }

  try {
    await sshCommand(`test -d ${DATA_DIRECTORY_ON_SERVER}`);
  } catch {
    throw new Error(
      "DATA_DIRECTORY_ON_SERVER must be a valid directory on the server"
    );
  }

  try {
    await sshCommand(`test -f ${ENV_FILE_ON_SERVER}`);
  } catch {
    throw new Error("ENV_FILE_ON_SERVER must be a valid file on the server");
  }

  // validate that DATA_DIRECTORY_ON_CONTAINER is a valid path
  if (
    !DATA_DIRECTORY_ON_CONTAINER ||
    typeof DATA_DIRECTORY_ON_CONTAINER !== "string" ||
    !DATA_DIRECTORY_ON_CONTAINER.startsWith("/") ||
    DATA_DIRECTORY_ON_CONTAINER.length < 2
  ) {
    throw new Error(
      "DATA_DIRECTORY_ON_CONTAINER must be a string starting with '/'"
    );
  }

  validatedConstants = true;
}

function validateMemoryString(memory) {
  const match = /^(\d+(?:\.\d+)?)(m|g)$/.exec(memory?.toLowerCase());
  if (!match) {
    return false;
  }

  const [, value, unit] = match;
  const memoryMB = unit === "g" ? parseFloat(value) * 1024 : parseFloat(value);

  return memoryMB >= MIN_MEMORY_MB && memoryMB <= MAX_MEMORY_MB;
}

function sanitizeString(str) {
  return String(str).replace(/[^a-zA-Z0-9._-]/g, "");
}

async function generateDockerCommand(container, platform, commitHash) {
  await validateConstants();

  // Type checking
  if (!container || typeof container !== "object") {
    throw new TypeError("Container configuration must be an object");
  }

  if (!platform || typeof platform !== "object") {
    throw new TypeError("Platform configuration must be an object");
  }

  if (typeof commitHash !== "string") {
    throw new TypeError("Commit hash must be a string");
  }

  const {
    name: containerName,
    port: containerPort,
    cpus,
    memory,
    maxOldSpaceSize,
  } = container;

  // Validate required fields
  if (!containerName || typeof containerName !== "string") {
    throw new Error("Container name is required and must be a string");
  }

  // Validate platform
  const platformOs = platform.platformOs?.toLowerCase();
  const platformArch = platform.platformArch?.toLowerCase();

  if (!VALID_PLATFORMS[platformOs]?.includes(platformArch)) {
    throw new Error(`Invalid platform: ${platformOs}/${platformArch}`);
  }

  // Validate commit hash
  if (!/^[0-9a-f]{40}$/i.test(commitHash)) {
    throw new Error("Invalid commit hash format");
  }

  // Validate port
  const portNum = parseInt(containerPort, 10);
  if (isNaN(portNum) || portNum < MIN_PORT || portNum > MAX_PORT) {
    throw new Error(`Port must be between ${MIN_PORT} and ${MAX_PORT}`);
  }

  // Validate CPUs
  const cpuValue = parseFloat(cpus);
  if (isNaN(cpuValue) || cpuValue < MIN_CPUS || cpuValue > MAX_CPUS) {
    throw new Error(`CPUs must be between ${MIN_CPUS} and ${MAX_CPUS}`);
  }

  // Validate memory
  if (!validateMemoryString(memory)) {
    throw new Error('Invalid memory format (should be like "512m" or "1.5g")');
  }

  // Validate maxOldSpaceSize
  const oldSpaceSize = parseInt(maxOldSpaceSize, 10);
  if (
    isNaN(oldSpaceSize) ||
    oldSpaceSize < MIN_OLD_SPACE_SIZE ||
    oldSpaceSize > MAX_OLD_SPACE_SIZE
  ) {
    throw new Error(
      `maxOldSpaceSize must be between ${MIN_OLD_SPACE_SIZE} and ${MAX_OLD_SPACE_SIZE}`
    );
  }

  // Sanitize inputs for command construction
  const sanitizedName = sanitizeString(containerName);

  // Construct command string
  return [
    "docker run",
    // Run the container in the background
    "-d",
    // If the container stops, restart it unless explicitly stopped
    "--restart unless-stopped",
    `--name ${sanitizedName}`,
    `--platform ${platformOs}/${platformArch}`,

    // Log driver configuration
    "--log-driver json-file",
    `--log-opt max-size=${LOG_MAX_SIZE}`,
    `--log-opt max-file=${LOG_MAX_FILE}`,

    // Expose the internal port to the host network
    // Since each container listens on the same internal port
    // we need to map it to a different port on the host
    `-p ${portNum}:${INTERNAL_PORT}`,
    `--env-file ${ENV_FILE_ON_SERVER}`,
    `-e CONTAINER_NAME=${sanitizedName}`,
    `-e BLOT_RELEASE_ID=${commitHash}`,
    // Configure the maximum memory usage for the node process
    `-e NODE_OPTIONS='--max-old-space-size=${oldSpaceSize}'`,
    // Routes bookmark-link screenshots (helper/screenshot) and remote-image
    // downloads (helper/transformer/download) through the airlock - see
    // config/airlock/README.md. This container is connected to
    // AIRLOCK.network after it starts (see deployContainer/
    // connectToAirlockNetwork in ../index.js), not via --network here - see
    // the comment on AIRLOCK in ../constants.js for why.
    `-e BLOT_AIRLOCK_BROWSER_URL=http://${AIRLOCK.name}:9222`,
    `-e BLOT_AIRLOCK_PROXY_URL=http://${AIRLOCK.name}:8888`,
    // Mount the data directory on the host to the container
    // Every container has access to the same data directory
    `-v ${DATA_DIRECTORY_ON_SERVER}:${DATA_DIRECTORY_ON_CONTAINER}`,
    `--memory=${memory}`,
    `--cpus=${cpuValue}`,
    `${REGISTRY_URL}:${commitHash}`,
  ].join(" ");
}

module.exports = generateDockerCommand;
