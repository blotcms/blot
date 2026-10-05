// npm run render-probe -- <url...> [options]
//
// Runs scripts/render-probe/probe.js on production in a throwaway container
// built from the same image (and env file, and data directory) as the app
// containers, then copies its output back to ./data/render-probe/<run>/.
// See README.md in this directory.

const { spawn, execFileSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const sshCommand = require("../deploy/util/sshCommand");
const askForConfirmation = require("../deploy/util/askForConfirmation");
const {
  REGISTRY_URL,
  ENV_FILE_ON_SERVER,
  DATA_DIRECTORY_ON_SERVER,
  DATA_DIRECTORY_ON_CONTAINER,
  CONTAINERS,
} = require("../deploy/constants");

const ACCESS_LOG_DIRECTORY = "/var/instance-ssd/logs";
const REMOTE_ROOT = "/tmp/render-probe";
const PROBE_IN_CONTAINER = "/usr/src/app/scripts/render-probe/probe.js";

// Options consumed here; everything else is passed through to probe.js.
const WRAPPER_FLAGS = {
  release: "image tag to run (default: yellow's current BLOT_RELEASE_ID)",
  memory: "container memory limit (default 3g)",
  "max-old-space": `V8 heap limit in MB (default ${CONTAINERS.YELLOW.maxOldSpaceSize}, as yellow)`,
  "heap-snapshot": "write a heap snapshot when the heap nears its limit",
  "cpu-prof": "write a CPU profile (on a clean exit)",
  "heap-prof": "write a sampling heap profile (on a clean exit)",
  yes: "skip the confirmation prompt",
};

function usage() {
  console.log(`Usage: npm run render-probe -- <url...> [options]

  npm run render-probe -- https://www.example.com/archives --concurrency 4 --repeat 2
  npm run render-probe -- --stats https://www.example.com
  npm run render-probe -- --replay access.log-20261002 --from 2026-10-01T10:00:00 --to 2026-10-01T10:03:30

Probe options (see scripts/render-probe/probe.js):
  --concurrency N       parallel requests (max 8)
  --repeat N            send each URL N times
  --urls <file>         extra URLs, one per line (a local file)
  --stats <url|handle>  catalog size/backlink facts, no rendering
  --replay <file>       replay yellow's requests from ${ACCESS_LOG_DIRECTORY}/<file>
  --from/--to           replay window, UTC (YYYY-MM-DDTHH:MM:SS)
  --speed N             replay speed multiplier (default 1)
  --timeout S           per-request timeout (default 120)
  --verbose             print each request's render steps

Wrapper options:`);
  for (const [flag, help] of Object.entries(WRAPPER_FLAGS)) {
    console.log(`  --${flag.padEnd(18)}${help}`);
  }
}

function shellQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

function splitArgs(argv) {
  const wrapper = {};
  const probe = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const key = arg.startsWith("--") ? arg.slice(2).split("=")[0] : null;
    if (key && key in WRAPPER_FLAGS) {
      if (arg.includes("=")) wrapper[key] = arg.split("=")[1];
      else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) wrapper[key] = argv[++i];
      else wrapper[key] = true;
    } else {
      probe.push(arg);
    }
  }
  return { wrapper, probe };
}

function parseMemoryMB(value) {
  const match = /^(\d+(?:\.\d+)?)([mg])$/i.exec(value);
  if (!match) throw new Error(`Invalid --memory ${value} (use e.g. 3g or 2500m)`);
  return Math.round(parseFloat(match[1]) * (match[2].toLowerCase() === "g" ? 1024 : 1));
}

// --urls names a local file, so inline its URLs; --replay names a file in
// ACCESS_LOG_DIRECTORY, which the probe sees through a read-only mount.
function rewriteFileArgs(probeArgs) {
  const copy = probeArgs.slice();

  const urls = copy.indexOf("--urls");
  if (urls !== -1) {
    const list = fs.readFileSync(copy[urls + 1], "utf8").split("\n").map((s) => s.trim());
    copy.splice(urls, 2, ...list.filter(Boolean));
  }

  const replay = copy.indexOf("--replay");
  if (replay !== -1) {
    const file = path.basename(copy[replay + 1] || "");
    if (!file) throw new Error("--replay needs a file name from " + ACCESS_LOG_DIRECTORY);
    copy[replay + 1] = "/logs/" + file;
  }

  return copy;
}

async function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv.includes("--help") || argv.includes("-h")) return usage();

  const { wrapper, probe } = splitArgs(argv);
  const probeArgs = rewriteFileArgs(probe);
  const memory = wrapper.memory || "3g";
  const memoryMB = parseMemoryMB(memory);
  const maxOldSpace = Number(wrapper["max-old-space"] || CONTAINERS.YELLOW.maxOldSpaceSize);

  let release = wrapper.release;
  if (!release) {
    const env = await sshCommand(
      `docker inspect ${CONTAINERS.YELLOW.name} --format '{{range .Config.Env}}{{println .}}{{end}}'`
    );
    const line = env.split("\n").find((l) => l.startsWith("BLOT_RELEASE_ID="));
    if (!line) throw new Error(`Could not read BLOT_RELEASE_ID from ${CONTAINERS.YELLOW.name}`);
    release = line.split("=")[1];
  }
  if (!/^[0-9a-f]{7,40}$/.test(release)) throw new Error(`Invalid --release ${release}`);

  // The probe shares the host with the live containers: refuse to start one
  // that could push the host into swapping or the kernel OOM killer.
  const availableMB = Number(await sshCommand("free -m | awk '/^Mem:/ {print \\$7}'"));
  if (!(availableMB > memoryMB + 512)) {
    throw new Error(
      `Only ${availableMB}MB available on the host; not starting a ${memory} probe. Try a smaller --memory.`
    );
  }

  const runId = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "");
  const name = `blot-render-probe-${runId.toLowerCase()}`;
  const remoteDir = `${REMOTE_ROOT}/${runId}`;

  const nodeOptions = [
    `--max-old-space-size=${maxOldSpace}`,
    "--report-on-fatalerror",
    "--report-directory=/out",
    "--report-exclude-env",
    "--report-exclude-network",
  ];
  if (wrapper["heap-snapshot"]) {
    nodeOptions.push("--heapsnapshot-near-heap-limit=1", "--diagnostic-dir=/out");
  }
  if (wrapper["cpu-prof"]) nodeOptions.push("--cpu-prof", "--cpu-prof-dir=/out");
  if (wrapper["heap-prof"]) nodeOptions.push("--heap-prof", "--heap-prof-dir=/out");

  const dockerRun = [
    "docker run --rm",
    `--name ${name}`,
    `--env-file ${ENV_FILE_ON_SERVER}`,
    // Not blot-container-*, so its render-time metrics stay out of the
    // daily numbers, and config.master is false (no scheduled jobs).
    "-e CONTAINER_NAME=blot-render-probe",
    `-e BLOT_RELEASE_ID=${release}`,
    `-e NODE_OPTIONS=${shellQuote(nodeOptions.join(" "))}`,
    `-v ${DATA_DIRECTORY_ON_SERVER}:${DATA_DIRECTORY_ON_CONTAINER}:ro`,
    `-v ${ACCESS_LOG_DIRECTORY}:/logs:ro`,
    `-v ${remoteDir}/out:/out`,
    `-v ${remoteDir}/probe.js:${PROBE_IN_CONTAINER}:ro`,
    `--memory=${memory}`,
    "--cpus=1",
    `${REGISTRY_URL}:${release}`,
    `node ${PROBE_IN_CONTAINER} --out /out`,
    ...probeArgs.map(shellQuote),
  ].join(" ");

  console.log(`\nRelease ${release}, ${availableMB}MB available on the host.`);
  console.log(`Will run on production:\n\n  ${dockerRun}\n`);
  if (!wrapper.yes && !(await askForConfirmation("Start the probe? (y/n) "))) return;

  await sshCommand(`mkdir -p ${remoteDir}/out && chmod 777 ${remoteDir}/out`);
  execFileSync("scp", ["-q", path.join(__dirname, "probe.js"), `blot:${remoteDir}/probe.js`]);

  // Ctrl-C stops the remote container too, then still fetches its output.
  let interrupted = false;
  process.on("SIGINT", () => {
    if (interrupted) process.exit(130);
    interrupted = true;
    console.log(`\nStopping ${name}...`);
    sshCommand(`docker kill ${name}`).catch(() => {});
  });

  const exitCode = await new Promise((resolve) => {
    const child = spawn("ssh", ["blot", dockerRun], { stdio: ["ignore", "inherit", "inherit"] });
    child.on("exit", (code) => resolve(code));
  });

  const localDir = path.join(process.cwd(), "data", "render-probe", runId);
  fs.mkdirSync(path.dirname(localDir), { recursive: true });
  execFileSync("scp", ["-q", "-r", `blot:${remoteDir}/out`, localDir]);
  await sshCommand(`rm -rf ${remoteDir}`);

  if (exitCode !== 0) {
    console.log(
      `\nProbe exited with ${exitCode} (134 = V8 out of memory, 137 = killed - out of container memory or Ctrl-C).`
    );
  }
  console.log(`Output: ${localDir}`);
  for (const file of fs.readdirSync(localDir)) console.log(`  ${file}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
