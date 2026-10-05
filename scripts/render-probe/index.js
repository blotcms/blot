// npm run render-probe -- <url...> [options]
//
// Runs scripts/render-probe/probe.js on production in a throwaway container
// built from the same image (and env file, and data directory) as the app
// containers, then copies its output back to ./data/render-probe/<run>/.
// The container itself is handled by the shared launcher in ../probe/run.js.
// See README.md in this directory.

const path = require("path");
const fs = require("fs");
const {
  runProbe,
  parseArgs,
  formatOptions,
  WRAPPER_OPTIONS,
  fromWrapperOptions,
} = require("../probe/run");
const { OPTIONS: PROBE_OPTIONS } = require("./probe");
const { CONTAINERS } = require("../deploy/constants");

const ACCESS_LOG_DIRECTORY = "/var/instance-ssd/logs";

// Handled here rather than by probe.js: --urls names a local file, so its
// URLs are inlined; --replay names a file in ACCESS_LOG_DIRECTORY, which the
// probe sees through a read-only mount.
const LOCAL_OPTIONS = {
  urls: { value: "FILE", help: "extra URLs, one per line (a local file)" },
  replay: {
    value: "FILE",
    help: `replay yellow's requests from ${ACCESS_LOG_DIRECTORY}/<file> (.gz too)`,
  },
};

const DEFAULTS = { memory: "3g", oldSpace: CONTAINERS.YELLOW.maxOldSpaceSize, cpus: 1 };

function usage() {
  const { out, replay, ...probeOptions } = PROBE_OPTIONS;
  console.log(`Usage: npm run render-probe -- <url...> [options]

  npm run render-probe -- https://www.example.com/archives --concurrency 4 --repeat 2
  npm run render-probe -- --stats https://www.example.com
  npm run render-probe -- --replay access.log-20261002.gz --from 2026-10-01T10:00:00 --to 2026-10-01T10:03:30

Probe options:
${formatOptions({ ...LOCAL_OPTIONS, ...probeOptions })}

Wrapper options (defaults: --memory ${DEFAULTS.memory}, --max-old-space ${DEFAULTS.oldSpace} as yellow):
${formatOptions(WRAPPER_OPTIONS)}`);
}

function probeArgsFrom(rest, local) {
  const args = rest.slice();
  if (local.urls) {
    const list = fs.readFileSync(local.urls, "utf8").split("\n").map((s) => s.trim());
    args.push(...list.filter(Boolean));
  }
  if (local.replay) {
    const file = path.basename(local.replay);
    if (!file || file === "." || file === "..") {
      throw new Error("--replay needs a file name from " + ACCESS_LOG_DIRECTORY);
    }
    args.push("--replay", "/logs/" + file);
  }
  return args;
}

async function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv.includes("--help") || argv.includes("-h")) return usage();

  const { options, rest } = parseArgs(argv, { ...WRAPPER_OPTIONS, ...LOCAL_OPTIONS }, { strict: false });
  const probeArgs = probeArgsFrom(rest, options);
  // Catch a typo here rather than in a container on production.
  parseArgs(probeArgs, PROBE_OPTIONS);

  const { exitCode } = await runProbe({
    tool: "render-probe",
    script: path.join(__dirname, "probe.js"),
    probeArgs,
    mounts: [`${ACCESS_LOG_DIRECTORY}:/logs:ro`],
    ...fromWrapperOptions(options, DEFAULTS),
  });
  if (exitCode) process.exitCode = exitCode;
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
