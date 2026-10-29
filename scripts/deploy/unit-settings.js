// Prints the settings proxy/deploy/blue-green.sh needs to create a unit, as
// KEY=VALUE lines, so the numbers live in ./constants.js only:
//
//   node scripts/deploy/unit-settings.js > unit-settings.env
//
// ./units.sh runs this and copies the result to the host next to the deploy
// scripts, where common.sh reads it. Every value is a plain word (no spaces or
// quotes), so the file can be sourced by a shell.
const constants = require("./constants");

const { UNIT, AIRLOCK } = constants;

function settings() {
  const values = {
    UNIT_CPUS: UNIT.cpus,
    UNIT_MEMORY: UNIT.memory,
    UNIT_CPU_SHARES: UNIT.cpuShares,
    UNIT_NODE_A_MAX_OLD_SPACE_SIZE: UNIT.nodeAMaxOldSpaceSize,
    UNIT_NODE_B_MAX_OLD_SPACE_SIZE: UNIT.nodeBMaxOldSpaceSize,
    UNIT_STOP_TIMEOUT: UNIT.stopTimeout,
    DATA_DIRECTORY_ON_SERVER: constants.DATA_DIRECTORY_ON_SERVER,
    DATA_DIRECTORY_ON_CONTAINER: constants.DATA_DIRECTORY_ON_CONTAINER,
    TMP_DIRECTORY: constants.TMP_DIRECTORY,
    SOCKET_DIRECTORY: constants.SOCKET_DIRECTORY,
    NODE_REPORT_DIRECTORY: constants.NODE_REPORT_DIRECTORY,
    SECRETS_ENV_FILE: constants.ENV_FILE_ON_SERVER,
    LOG_MAX_SIZE: constants.LOG_MAX_SIZE,
    LOG_MAX_FILE: constants.LOG_MAX_FILE,
    LOG_COMPRESS: constants.LOG_COMPRESS,
    AIRLOCK_REGISTRY: AIRLOCK.registry,
    AIRLOCK_NETWORK: AIRLOCK.network,
    AIRLOCK_MEMORY: AIRLOCK.memory,
    AIRLOCK_CPUS: AIRLOCK.cpus,
    AIRLOCK_CPU_SHARES: AIRLOCK.cpuShares,
  };

  for (const [unit, airlock] of Object.entries(AIRLOCK.units)) {
    const key = unit.toUpperCase();
    values[`AIRLOCK_${key}_NAME`] = airlock.name;
    values[`AIRLOCK_${key}_BROWSER_PORT`] = airlock.browserPort;
    values[`AIRLOCK_${key}_PROXY_PORT`] = airlock.proxyPort;
  }

  for (const [key, value] of Object.entries(values)) {
    if (!/^[A-Za-z0-9._/:-]+$/.test(String(value))) {
      throw new Error(`${key}=${value} is not a plain word`);
    }
  }

  return values;
}

function render() {
  return Object.entries(settings())
    .map(([key, value]) => `${key}=${value}`)
    .join("\n") + "\n";
}

if (require.main === module) process.stdout.write(render());

module.exports = { settings, render };
