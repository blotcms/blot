// Shared launcher for the production probes (scripts/render-probe and
// scripts/build-probe). Runs a probe script on the production host in
// a throwaway container of the live image, with the production env file and
// data directory, its own memory and CPU caps and no published port, then
// copies what it wrote to ./data/<tool>/<run>/ and removes it from the host.
//
//   const { runProbe, parseArgs, WRAPPER_OPTIONS, fromWrapperOptions } = require("../probe/run");
//   const { options, rest } = parseArgs(argv, WRAPPER_OPTIONS, { strict: false });
//   const { exitCode } = await runProbe({
//     tool: "render-probe",
//     script: path.join(__dirname, "probe.js"),
//     probeArgs: rest,
//     ...fromWrapperOptions(options, { memory: "3g", oldSpace: 1500 }),
//   });
//
// The probe script is called as `node <flags> <script> --out=/out <probeArgs>`
// and must write everything it wants back into /out (files only, not
// subdirectories: the container's user owns what it creates there, and the
// ssh user may not be able to delete a subdirectory's contents).

const { spawn, execFile } = require("child_process");
const { promisify } = require("util");
const path = require("path");
const fs = require("fs");
const sshCommand = require("../deploy/util/sshCommand");
const askForConfirmation = require("../deploy/util/askForConfirmation");
const { AIRLOCK_ENV } = require("../deploy/util/generateDockerCommand");
const { parseArgs, formatOptions } = require("./args");
const {
  REGISTRY_URL,
  ENV_FILE_ON_SERVER,
  DATA_DIRECTORY_ON_SERVER,
  DATA_DIRECTORY_ON_CONTAINER,
  AIRLOCK,
  CONTAINERS,
} = require("../deploy/constants");

const execFileAsync = promisify(execFile);

const REPO_ROOT = path.resolve(__dirname, "../..");
const APP_ROOT_IN_CONTAINER = "/usr/src/app";
const REMOTE_ROOT = "/tmp/blot-probe";
const OUT = "/out";

// Shipped with every probe script, mounted at the same place relative to
// the app root as in this repository, so the script can require them.
const SHARED_FILES = [path.join(__dirname, "args.js"), path.join(__dirname, "instrument.js")];

// Options every probe wrapper takes; see fromWrapperOptions.
const WRAPPER_OPTIONS = {
  release: { value: "SHA", help: "image tag to run (default: yellow's current image)" },
  memory: { value: "SIZE", help: "container memory limit, e.g. 3g or 2500m" },
  "max-old-space": { value: "MB", help: "V8 heap limit" },
  cpus: { value: "N", help: "container CPU limit (default 1)" },
  "heap-snapshot": { help: "write a heap snapshot when the heap nears its limit" },
  "cpu-prof": { help: "write a CPU profile (on a clean exit)" },
  "heap-prof": { help: "write a sampling heap profile (on a clean exit)" },
  yes: { help: "skip the confirmation prompt" },
};

// Maps parsed WRAPPER_OPTIONS onto runProbe's options; defaults gives the
// probe's own { memory, oldSpace, cpus }.
function fromWrapperOptions(options, defaults = {}) {
  return {
    release: options.release,
    memory: options.memory || defaults.memory,
    oldSpace: Number(options["max-old-space"] || defaults.oldSpace),
    cpus: Number(options.cpus || defaults.cpus || 1),
    heapSnapshot: !!options["heap-snapshot"],
    cpuProf: !!options["cpu-prof"],
    heapProf: !!options["heap-prof"],
    yes: !!options.yes,
  };
}

function shellQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

function parseMemoryMB(value) {
  const match = /^(\d+(?:\.\d+)?)([mg])$/i.exec(value || "");
  if (!match) throw new Error(`Invalid --memory ${value} (use e.g. 3g or 2500m)`);
  return Math.round(parseFloat(match[1]) * (match[2].toLowerCase() === "g" ? 1024 : 1));
}

// runProbe options:
//   tool          names the container (blot-<tool>-<run>), the host directory
//                 and ./data/<tool>/; lowercase letters and dashes
//   script        local path of the probe script, inside this repository
//   probeArgs     arguments for the script (after --out=/out)
//   memory        container memory limit, e.g. "3g"
//   oldSpace      V8 heap limit in MB (--max-old-space-size)
//   cpus          container CPU limit (default 1)
//   release       image tag (a commit SHA) instead of yellow's current image
//   yes           skip the confirmation prompt
//   heapSnapshot  --heapsnapshot-near-heap-limit=1, written to /out
//   cpuProf       --cpu-prof, written to /out
//   heapProf      --heap-prof, written to /out
//   nodeFlags     extra node flags, e.g. ["--expose-gc"]
//   writableData  mount the data directory read-write (default read-only)
//   airlock       connect the container to the airlock network before it
//                 starts and pass the airlock env vars, as the deploy does
//   mounts        extra -v specs, e.g. ["/var/instance-ssd/logs:/logs:ro"]
//   env           extra environment variables, { NAME: value }
//
// Resolves to { exitCode, localDir }; exitCode is the container's, or null
// if it never ran.
async function runProbe({
  tool,
  script,
  probeArgs = [],
  memory,
  oldSpace,
  cpus = 1,
  release,
  yes = false,
  heapSnapshot = false,
  cpuProf = false,
  heapProf = false,
  nodeFlags = [],
  writableData = false,
  airlock = false,
  mounts = [],
  env = {},
}) {
  if (!/^[a-z][a-z-]*$/.test(tool)) throw new Error(`Invalid tool name ${tool}`);
  const memoryMB = parseMemoryMB(memory);
  if (!(oldSpace >= 256 && oldSpace < memoryMB)) {
    throw new Error(`Invalid heap limit ${oldSpace}MB: it must be below the ${memory} memory limit`);
  }
  if (!(cpus > 0 && cpus <= 4)) throw new Error(`Invalid --cpus ${cpus}`);
  if (probeArgs.some((arg) => /^--out(=|$)/.test(arg))) {
    throw new Error(`--out isn't supported: results always come back to data/${tool}`);
  }

  const image = await chooseImage(release);
  const releaseId = image.split(":").pop();

  // The probe shares the host with the live containers: refuse to start one
  // that could push the host into swapping or the kernel OOM killer, or fill
  // the disk with a heap snapshot (about as large as the heap) and profiles.
  const availableMB = Number(await sshCommand("free -m | awk '/^Mem:/ {print \\$7}'"));
  if (!(availableMB > memoryMB + 512)) {
    throw new Error(
      `Only ${availableMB}MB available on the host; not starting a ${memory} probe. Try a smaller --memory.`
    );
  }
  const [fsType, freeKB] = (
    await sshCommand(`df -PTk ${path.posix.dirname(REMOTE_ROOT)} | awk 'NR==2 {print \\$2, \\$5}'`)
  ).split(" ");
  const freeMB = Math.floor(Number(freeKB) / 1024);
  const neededMB = 2 * oldSpace + 1024;
  if (!(freeMB >= neededMB)) {
    throw new Error(
      `Only ${freeMB}MB free for ${REMOTE_ROOT} on the host; a probe with a ${oldSpace}MB heap needs ${neededMB}MB.`
    );
  }

  const runId = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "");
  const name = `blot-${tool}-${runId.toLowerCase()}`;
  const remoteDir = `${REMOTE_ROOT}/${tool}/${runId}`;
  const localDir = path.join(process.cwd(), "data", tool, runId);

  // Each script is uploaded under the run directory and mounted where it
  // sits in the repository, so `require("models/...")` (NODE_PATH) and
  // relative requires of the shared files both resolve inside the image.
  const files = [script, ...SHARED_FILES].map((local, i) => {
    const relative = path.relative(REPO_ROOT, path.resolve(local));
    if (relative.startsWith("..")) throw new Error(`${local} is outside the repository`);
    return {
      local,
      remote: `${remoteDir}/${i}-${path.basename(local)}`,
      container: path.posix.join(APP_ROOT_IN_CONTAINER, relative.split(path.sep).join("/")),
    };
  });

  const node = [
    "node",
    `--max-old-space-size=${oldSpace}`,
    "--report-on-fatalerror",
    `--report-directory=${OUT}`,
    "--report-exclude-env",
    "--report-exclude-network",
    ...(heapSnapshot ? ["--heapsnapshot-near-heap-limit=1", `--diagnostic-dir=${OUT}`] : []),
    ...(cpuProf ? ["--cpu-prof", `--cpu-prof-dir=${OUT}`] : []),
    ...(heapProf ? ["--heap-prof", `--heap-prof-dir=${OUT}`] : []),
    ...nodeFlags,
    files[0].container,
    `--out=${OUT}`,
    ...probeArgs,
  ];

  const environment = {
    // config.container is the part after "blot-<x>-", so log lines are
    // tagged [<tool>]; and config.master is false.
    CONTAINER_NAME: `blot-probe-${tool}`,
    ...(/^[0-9a-f]{7,40}$/.test(releaseId) ? { BLOT_RELEASE_ID: releaseId } : {}),
    // Empty, so the env file can't override the flags given to node below.
    NODE_OPTIONS: "",
    ...(airlock ? AIRLOCK_ENV : {}),
    ...env,
  };

  const dockerCreate = [
    "docker create",
    `--name ${name}`,
    "--restart no",
    `--env-file ${ENV_FILE_ON_SERVER}`,
    ...Object.entries(environment).map(([key, value]) => `-e ${shellQuote(`${key}=${value}`)}`),
    `-v ${DATA_DIRECTORY_ON_SERVER}:${DATA_DIRECTORY_ON_CONTAINER}${writableData ? "" : ":ro"}`,
    `-v ${remoteDir}/out:${OUT}`,
    ...files.map((file) => `-v ${shellQuote(`${file.remote}:${file.container}:ro`)}`),
    ...mounts.map((mount) => `-v ${shellQuote(mount)}`),
    // --memory-swap equal to --memory: no swap, so the probe can't push the
    // host into swapping; it is OOM-killed at the limit instead.
    `--memory=${memory}`,
    `--memory-swap=${memory}`,
    `--cpus=${cpus}`,
    image,
    ...node.map(shellQuote),
  ].join(" ");

  // Mirrors the deploy (scripts/deploy/util/generateDockerCommand.js): the
  // airlock network is connected after create and before start.
  const remoteCommand = [
    `${dockerCreate} > /dev/null`,
    ...(airlock ? [`docker network connect ${AIRLOCK.network} ${name}`] : []),
    `docker start -a ${name}`,
  ].join(" && ");

  console.log(`\nImage ${image}${release ? await describePull(image) : ""}`);
  console.log(
    `Container ${name}: memory ${memory}, cpus ${cpus}, heap limit ${oldSpace}MB,` +
      ` data ${writableData ? "READ-WRITE" : "read-only"}${airlock ? ", airlock network" : ""}`
  );
  console.log(`Host: ${availableMB}MB memory available, ${freeMB}MB free for ${REMOTE_ROOT} (${fsType})`);
  if (fsType === "tmpfs") {
    console.log(`Note: ${REMOTE_ROOT} is on tmpfs, so the probe's output is held in the host's memory.`);
  }
  console.log(`Will run on production:\n\n  ${remoteCommand.split(" && ").join(" &&\n  ")}\n`);
  if (!yes && !(await askForConfirmation("Start the probe? (y/n) "))) return { exitCode: null, localDir: null };

  // Ctrl-C stops the container, then still fetches its output and cleans
  // up. A second one is ignored, a third abandons the cleanup.
  let interrupts = 0;
  let stopping = null;
  const stop = () => {
    if (!stopping) {
      console.log(`\nStopping ${name}...`);
      stopping = sshCommand(`docker kill ${name} > /dev/null 2>&1 || true`).catch(() => {});
    }
    return stopping;
  };
  const onInterrupt = () => {
    interrupts++;
    if (interrupts === 1) return stop();
    if (interrupts === 2) {
      return console.log("\nStill cleaning up; press Ctrl-C again to abandon it.");
    }
    console.log(
      `\nAbandoned. Remove the container with: ssh blot docker rm -f ${name}` +
        `\nThe results (which hold secrets and customer content) are at blot:${remoteDir}`
    );
    process.exit(130);
  };
  process.on("SIGINT", onInterrupt);

  let exitCode = null;
  try {
    // The run directory is the ssh user's and closed to everyone else; only
    // out/ is open, because the container (uid 1000, maybe not the ssh user)
    // writes there. Docker bind-mounts out/ directly, so the container never
    // has to traverse the closed parent.
    await sshCommand(
      `mkdir -p ${REMOTE_ROOT}/${tool} && mkdir -m 700 ${remoteDir} && mkdir -m 777 ${remoteDir}/out`
    );
    for (const file of files) {
      await execFileAsync("scp", ["-q", file.local, `blot:${file.remote}`]);
    }

    if (!stopping) {
      await new Promise((resolve) => {
        const child = spawn("ssh", ["blot", remoteCommand], { stdio: ["ignore", "inherit", "inherit"] });
        child.on("exit", resolve);
        child.on("error", resolve);
      });

      // An attached container keeps running if the ssh connection drops.
      const running = await sshCommand(
        `docker inspect ${name} --format '{{.State.Running}}' 2>/dev/null || true`
      );
      if (running === "true" && !stopping) {
        console.log(`\nLost the connection to ${name} while it was running.`);
        stop();
      }
      await stopping;
      await sshCommand(`docker wait ${name} > /dev/null 2>&1 || true`);

      const state = await sshCommand(
        `docker inspect ${name} --format '{{.State.ExitCode}} {{.State.OOMKilled}}' 2>/dev/null || true`
      );
      if (state) {
        const [code, oomKilled] = state.split(" ");
        exitCode = Number(code);
        console.log(`\n${name} exited with ${exitCode}, OOMKilled=${oomKilled}`);
        if (exitCode !== 0) {
          console.log("(134 = V8 out of memory, 137 = killed - out of container memory, or Ctrl-C)");
        }
      }
    }
  } finally {
    await cleanUp({ name, remoteDir, localDir });
    process.removeListener("SIGINT", onInterrupt);
  }

  return { exitCode, localDir };
}

// yellow's image unless --release; the image name, never its environment
// (which holds the production secrets).
async function chooseImage(release) {
  if (release) {
    // Images are tagged with the full commit SHA, so expand a short one.
    if (!/^[0-9a-f]{7,40}$/.test(release)) throw new Error(`Invalid --release ${release}`);
    let sha;
    try {
      ({ stdout: sha } = await execFileAsync(
        "git",
        ["rev-parse", "--verify", "--quiet", `${release}^{commit}`],
        { cwd: REPO_ROOT }
      ));
    } catch (err) {
      throw new Error(`--release ${release} isn't a commit in this checkout (try git fetch)`);
    }
    sha = sha.trim();
    if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`Couldn't resolve --release ${release}: ${sha}`);
    return `${REGISTRY_URL}:${sha}`;
  }
  const image = await sshCommand(
    `docker inspect ${CONTAINERS.YELLOW.name} --format '{{.Config.Image}}'`
  );
  if (!/^[\w./:@-]+$/.test(image)) throw new Error(`Unexpected image for ${CONTAINERS.YELLOW.name}: ${image}`);
  return image;
}

async function describePull(image) {
  const present = await sshCommand(
    `docker image inspect --format ok ${image} 2>/dev/null || echo missing`
  );
  return present === "ok"
    ? " (already on the host)"
    : " (NOT on the host: it will be pulled first, which can take several GB of disk)";
}

// Runs however the probe ended. Removes the container, copies out/ back,
// and only deletes the host copy once that worked - the results hold
// secrets and customer content, so they shouldn't silently stay on the
// host, but they shouldn't be lost either.
async function cleanUp({ name, remoteDir, localDir }) {
  try {
    await sshCommand(`docker rm -f ${name} > /dev/null 2>&1 || true`);
  } catch (err) {
    console.error(`Couldn't remove the container: run ssh blot docker rm -f ${name}`);
  }

  let fetched = false;
  try {
    const exists = await sshCommand(`test -d ${remoteDir} && echo yes || echo no`);
    if (exists === "no") return;
    fs.mkdirSync(path.dirname(localDir), { recursive: true });
    await execFileAsync("scp", ["-q", "-r", `blot:${remoteDir}/out`, localDir]);
    fetched = true;
    await sshCommand(`rm -rf ${remoteDir}`);
    console.log(`\nOutput (removed from the host): ${localDir}`);
    for (const file of fs.readdirSync(localDir)) console.log(`  ${file}`);
  } catch (err) {
    console.error(err.message);
    console.error(
      fetched
        ? `\nOutput: ${localDir}, but couldn't remove blot:${remoteDir} - remove it by hand.`
        : `\nCouldn't fetch the output: it is still at blot:${remoteDir} - fetch and remove it by hand.`
    );
  }
}

module.exports = {
  runProbe,
  parseArgs,
  formatOptions,
  WRAPPER_OPTIONS,
  fromWrapperOptions,
  OUT,
};
