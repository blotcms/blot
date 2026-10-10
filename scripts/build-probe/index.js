// npm run build-probe -- <target...> [options]
//
// Runs scripts/build-probe/probe.js on production in a throwaway container
// built from the same image (and env file, and data directory) as the app
// containers, then copies its output back to ./data/build-probe/<run>/.
// The container itself is handled by the shared launcher in ../probe/run.js.
// See README.md in this directory.

const path = require("path");
const {
  runProbe,
  parseArgs,
  formatOptions,
  WRAPPER_OPTIONS,
  fromWrapperOptions,
  OUT,
} = require("../probe/run");
const { OPTIONS: PROBE_OPTIONS, checkOptions } = require("./probe");
const { CONTAINERS } = require("../deploy/constants");

// As green, the container that crashed; 2g leaves room for a heap snapshot
// on top of a full heap.
const DEFAULTS = { memory: "2g", oldSpace: CONTAINERS.GREEN.maxOldSpaceSize, cpus: 1 };

// --out is the launcher's: results always come back to data/build-probe.
const { out, ...probeOptions } = PROBE_OPTIONS;

function usage() {
  console.log(`Usage: npm run build-probe -- <target...> [options]

A target is a post URL or <blog>:<path>, where <blog> is a blog ID, handle or domain.

  npm run build-probe -- https://www.example.com/some-post --repeat 3
  npm run build-probe -- "example.com:/Posts/2026-10 Index.md" --snapshot-at 500
  npm run build-probe -- https://www.example.com/some-post --mode sync

Probe options:
${formatOptions(probeOptions)}

Wrapper options (defaults: --memory ${DEFAULTS.memory}, --max-old-space ${DEFAULTS.oldSpace} as green):
${formatOptions(WRAPPER_OPTIONS)}`);
}

async function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv.includes("--help") || argv.includes("-h")) return usage();

  const { options, rest: probeArgs } = parseArgs(argv, WRAPPER_OPTIONS, { strict: false });
  // Catch a typo here rather than in a container on production.
  const probe = parseArgs(probeArgs, probeOptions);
  const { mode } = checkOptions(probe.options);
  if (!probe.rest.length) throw new Error("Pass at least one post URL or <blog>:<path>");

  // See checkOptions in probe.js: a heap snapshot outlasts the sync lock.
  if (mode === "sync" && options["heap-snapshot"]) {
    throw new Error("--heap-snapshot can't be used with --mode sync: the snapshot would outlast the sync lock");
  }

  if (mode === "sync") {
    console.log(
      "\n--mode sync re-saves these posts for real: it takes each blog's sync lock (a Dropbox" +
        "\nor other sync for that blog arriving meanwhile fails to get it), shows 'Syncing' on" +
        "\nthe dashboard, purges the blog from the proxy caches, rebuilds its templates, checks" +
        "\nfor renames, and bumps its cacheID, which changes its CSS and JS URLs."
    );
  } else {
    console.log(
      "\nMid-run heap snapshot, from another terminal:" +
        "\n  ssh blot docker kill -s USR2 <the container named below>"
    );
  }

  const { exitCode } = await runProbe({
    tool: "build-probe",
    script: path.join(__dirname, "probe.js"),
    probeArgs,
    // Either mode builds, and a build uploads the images and thumbnails it
    // caches to the assets bucket (its scratch files, and the staging area
    // for those uploads, go in the tmp mount run.js adds).
    writableData: true,
    // Builds fetch remote images and take screenshots through the airlock.
    airlock: true,
    nodeFlags: [
      "--expose-gc",
      ...(mode === "build" ? ["--heapsnapshot-signal=SIGUSR2", `--diagnostic-dir=${OUT}`] : []),
    ],
    ...fromWrapperOptions(options, DEFAULTS),
  });
  if (exitCode) process.exitCode = exitCode;
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
