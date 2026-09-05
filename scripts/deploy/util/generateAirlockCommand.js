const CONSTANTS = require("../constants");

const { AIRLOCK } = CONSTANTS;
const { LOG_MAX_SIZE, LOG_MAX_FILE } = CONSTANTS;

const VALID_PLATFORMS = {
  linux: ["amd64", "arm64"],
};

function generateAirlockCommand(platform, commitHash) {
  if (!platform || typeof platform !== "object") {
    throw new TypeError("Platform configuration must be an object");
  }

  const platformOs = platform.platformOs?.toLowerCase();
  const platformArch = platform.platformArch?.toLowerCase();

  if (!VALID_PLATFORMS[platformOs]?.includes(platformArch)) {
    throw new Error(`Invalid platform: ${platformOs}/${platformArch}`);
  }

  if (!/^[0-9a-f]{40}$/i.test(commitHash)) {
    throw new Error("Invalid commit hash format");
  }

  return [
    "docker run",
    "-d",
    "--restart unless-stopped",
    `--name ${AIRLOCK.name}`,
    `--platform ${platformOs}/${platformArch}`,
    `--network ${AIRLOCK.network}`,
    // Needed for the entrypoint to install the nftables egress filter -
    // see config/airlock/egress.nft. The container fails closed (exits
    // non-zero) if this is missing rather than coming up unfiltered.
    "--cap-add=NET_ADMIN",
    "--security-opt no-new-privileges",
    "--log-driver json-file",
    `--log-opt max-size=${LOG_MAX_SIZE}`,
    `--log-opt max-file=${LOG_MAX_FILE}`,
    `--memory=${AIRLOCK.memory}`,
    `--cpus=${AIRLOCK.cpus}`,
    `${AIRLOCK.registry}:${commitHash}`,
  ].join(" ");
}

module.exports = generateAirlockCommand;
