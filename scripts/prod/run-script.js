// node scripts/prod/run-script.js [--release SHA] [--wait] <script> [args...]
//
// Runs a script from this repository on production in a container of its own,
// built from the live image, for anything too heavy for the 256 MB heap a
// script gets when run with `docker exec` inside a unit (see "Production
// commands" in AGENTS.md). The container has what a script run in a unit
// sees: the production env file, the data directory (read-write, so a backfill
// with --apply works), the tmp directory and the Redis socket directory. Its
// limits are SCRIPT_RUNNER in scripts/deploy/constants.js: a 512m container
// (no swap) and a 384 MB heap, with oom_score_adj 1000 so the kernel kills it
// before a unit's processes.
//
// One at a time on the host: a flock on a lock file, so a second run refuses
// at once, or waits for the first with --wait. Output streams as it runs. It
// asks for confirmation first, as the probes do.
//
//   node scripts/prod/run-script.js scripts/some/backfill.js --apply
//   node scripts/prod/run-script.js --release 1a2b3c4 scripts/some/backfill.js
//
// The script that runs is the image's copy of the path (the deployed code, so
// a new script has to be deployed first); the local file only has to exist.
// Options before the script are this runner's, everything after it goes to the
// script.

const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const sshCommand = require("../deploy/util/sshCommand");
const askForConfirmation = require("../deploy/util/askForConfirmation");
const { shellQuote, chooseImage, describePull } = require("../probe/run");
const {
  ENV_FILE_ON_SERVER,
  DATA_DIRECTORY_ON_SERVER,
  DATA_DIRECTORY_ON_CONTAINER,
  SOCKET_DIRECTORY,
  TMP_DIRECTORY,
  SCRIPT_RUNNER,
} = require("../deploy/constants");

const REPO_ROOT = path.resolve(__dirname, "../..");
const APP_ROOT_IN_CONTAINER = "/usr/src/app";
const LOCK_FILE = "/tmp/blot-run-script.lock";
// flock's exit code when another run holds the lock (-E), which no script uses
const LOCKED = 75;

function usage() {
  console.log(`Usage: node scripts/prod/run-script.js [--release SHA] [--wait] <script> [script args...]

Runs <script> (a path in this repository, as deployed in the image) on production
in its own container: node --max-old-space-size=${SCRIPT_RUNNER.oldSpace}, ${SCRIPT_RUNNER.memory} of memory and no swap,
oom_score_adj 1000, the data directory read-write. One at a time on the host.

  --release SHA  run that image instead of blot-blue's current one
  --wait         wait for a run that is in progress instead of refusing

  node scripts/prod/run-script.js scripts/some/backfill.js --apply`);
}

function parse(argv) {
  const options = {};
  let i = 0;
  for (; i < argv.length && argv[i].startsWith("--"); i++) {
    if (argv[i] === "--wait") options.wait = true;
    else if (argv[i] === "--release") options.release = argv[++i];
    else if (argv[i].startsWith("--release="))
      options.release = argv[i].slice("--release=".length);
    else throw new Error(`Unknown option ${argv[i]}`);
  }
  return { options, script: argv[i], args: argv.slice(i + 1) };
}

async function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv.includes("--help") || argv.includes("-h"))
    return usage();

  const { options, script, args } = parse(argv);
  if (!script) throw new Error("No script given");
  const relative = path.relative(REPO_ROOT, path.resolve(script));
  if (relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error(`${script} is outside the repository`);
  if (!fs.statSync(path.resolve(script), { throwIfNoEntry: false })?.isFile())
    throw new Error(`${script} isn't a file`);
  const containerScript = path.posix.join(
    APP_ROOT_IN_CONTAINER,
    relative.split(path.sep).join("/")
  );

  const { memory, oldSpace } = SCRIPT_RUNNER;
  const memoryMB = parseInt(memory, 10);

  console.log("Checking production: image and free memory...");
  const image = await chooseImage(options.release);
  const releaseId = image.split(":").pop();
  const availableMB = Number(
    await sshCommand("free -m | awk '/^Mem:/ {print \\$7}'")
  );
  if (!(availableMB > memoryMB + 512)) {
    throw new Error(
      `Only ${availableMB}MB available on the host; not starting a ${memory} script.`
    );
  }

  const name = `blot-script-${new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\..*/, "")
    .toLowerCase()}`;

  const environment = {
    CONTAINER_NAME: "blot-script",
    ...(/^[0-9a-f]{7,40}$/.test(releaseId)
      ? { BLOT_RELEASE_ID: releaseId }
      : {}),
    // Empty, so the env file can't override the flags given to node below
    NODE_OPTIONS: "",
    BLOT_TMP_DIRECTORY: TMP_DIRECTORY,
  };

  const dockerRun = [
    "docker run --rm",
    `--name ${name}`,
    `--env-file ${ENV_FILE_ON_SERVER}`,
    ...Object.entries(environment).map(
      ([key, value]) => `-e ${shellQuote(`${key}=${value}`)}`
    ),
    `-v ${DATA_DIRECTORY_ON_SERVER}:${DATA_DIRECTORY_ON_CONTAINER}`,
    `--mount ${shellQuote(`type=bind,source=${TMP_DIRECTORY},target=${TMP_DIRECTORY}`)}`,
    // Redis's Unix socket, when BLOT_REDIS_SOCKET is set (the container is on
    // a bridge network, which a host running Redis drops from its TCP port)
    `--mount ${shellQuote(`type=bind,source=${SOCKET_DIRECTORY},target=${SOCKET_DIRECTORY},readonly`)}`,
    // no swap, so it can't push the host into swapping: killed at the limit,
    // and ahead of the units' processes
    `--memory=${memory}`,
    `--memory-swap=${memory}`,
    "--oom-score-adj 1000",
    "--cpus=1",
    "--entrypoint /sbin/tini",
    image,
    "--",
    ...[
      "node",
      `--max-old-space-size=${oldSpace}`,
      containerScript,
      ...args,
    ].map(shellQuote),
  ].join(" ");

  // The lock is held for as long as the container runs; --rm removes the
  // container however it ends
  const remoteCommand = `flock ${options.wait ? "" : "-n "}-E ${LOCKED} ${LOCK_FILE} ${dockerRun}`;

  console.log(
    `\nImage ${image}${options.release ? await describePull(image) : ""}`
  );
  console.log(
    `Container ${name}: memory ${memory}, heap limit ${oldSpace}MB, oom_score_adj 1000, data READ-WRITE`
  );
  console.log(`Host: ${availableMB}MB memory available`);
  console.log(`Will run on production:\n\n  ${remoteCommand}\n`);
  if (!(await askForConfirmation("Run the script? (y/n) "))) return;

  // Ctrl-C stops the container; ssh without a terminal would leave it running
  let stopping = null;
  const onInterrupt = () => {
    if (stopping) return;
    console.log(`\nStopping ${name}...`);
    stopping = sshCommand(`docker kill ${name} > /dev/null 2>&1 || true`).catch(
      () => {}
    );
  };
  process.on("SIGINT", onInterrupt);

  let code;
  try {
    code = await new Promise((resolve) => {
      const child = spawn("ssh", ["blot", remoteCommand], {
        stdio: ["ignore", "inherit", "inherit"],
      });
      child.on("exit", (exitCode) => resolve(exitCode));
      child.on("error", () => resolve(null));
    });
    await stopping;
  } finally {
    process.removeListener("SIGINT", onInterrupt);
  }

  if (code === LOCKED) {
    console.log(
      "\nAnother script is running on the host: wait for it, or use --wait."
    );
  } else if (code !== 0) {
    console.log(
      `\n${name} exited with ${code} (134 = V8 out of memory, 137 = killed: out of the ${memory} container memory, or Ctrl-C)`
    );
  }
  process.exitCode = code === null ? 1 : code;
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
