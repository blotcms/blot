// npm run fix-probe -- <blog> [options]
//
// Runs scripts/fix-probe/probe.js on production in a throwaway container
// built from the same image (and env file, and data directory) as the app
// containers, then copies its output back to ./data/fix-probe/<run>/.
// The container itself is handled by the shared launcher in ../probe/run.js.
// See README.md in this directory.

const path = require("path");
const {
  runProbe,
  parseArgs,
  formatOptions,
  WRAPPER_OPTIONS,
  fromWrapperOptions,
} = require("../probe/run");
const { OPTIONS: PROBE_OPTIONS, checkOptions } = require("./probe");
const { CONTAINERS } = require("../deploy/constants");

// As green, which runs Fix() from the hourly Dropbox and iCloud validators.
const DEFAULTS = { memory: "2g", oldSpace: CONTAINERS.GREEN.maxOldSpaceSize, cpus: 1 };

// --out is the launcher's: results always come back to data/fix-probe.
const { out, ...probeOptions } = PROBE_OPTIONS;

function usage() {
  console.log(`Usage: npm run fix-probe -- <blog id|handle|domain> [options]

  npm run fix-probe -- blog_3dc3b49ffb3043039c7585bbfb6e8c2f --stats-only
  npm run fix-probe -- blog_3dc3b49ffb3043039c7585bbfb6e8c2f --repeat 2

Probe options:
${formatOptions(probeOptions)}

Wrapper options (defaults: --memory ${DEFAULTS.memory}, --max-old-space ${DEFAULTS.oldSpace} as green):
${formatOptions(WRAPPER_OPTIONS)}`);
}

async function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv.includes("--help") || argv.includes("-h")) return usage();

  const { options, rest } = parseArgs(argv, WRAPPER_OPTIONS, { strict: false });
  // Catch a typo here rather than in a container on production.
  const parsed = parseArgs(rest, probeOptions);
  checkOptions(parsed.options);
  if (parsed.rest.length !== 1) throw new Error("Pass one blog: its ID, handle or domain");

  const { exitCode } = await runProbe({
    tool: "fix-probe",
    script: path.join(__dirname, "probe.js"),
    probeArgs: rest,
    // On blotnet like green, so its Redis traffic takes the same path.
    airlock: true,
    ...fromWrapperOptions(options, DEFAULTS),
  });
  if (exitCode) process.exitCode = exitCode;
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
