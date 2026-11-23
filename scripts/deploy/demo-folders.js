#!/usr/bin/env node
// Syncs the demo folders (app/templates/folders) into the production demo
// blogs and uploads their download ZIPs, sending only the folders that
// changed (#2940). The unit image doesn't carry them.
//
//   node scripts/deploy/demo-folders.js [<commit>]
//
// Run by .github/workflows/deploy.yml, or from the maintainer's Mac, over the
// same ssh target as units.sh (BLOT_DEPLOY_TARGET, default blot). <commit>
// defaults to HEAD. Safe to re-run.
//
// 1. Each folder's git tree hash at <commit> is compared with the marker,
//    ~/demo-folders.json on the host (in the deploy user's home on the root
//    volume: the app's tmp directory is on the instance store, which a
//    stop/start wipes, and prune-tmp empties it daily). A lost marker only
//    means every folder is synced once, which writes nothing that matches.
// 2. The changed folders go over ssh, as a tar from git archive, into
//    <tmp>/demo-folders/<commit>/ inside the unit: the app's tmp directory
//    is bind-mounted into every unit at the same path.
// 3. For each, one at a time, the unit runs app/templates/folders/index.js
//    --from <dir> --only <name> --zip, which writes the changed files, runs
//    sync and Fix, and uploads the ZIP. The marker is updated after each
//    folder that succeeds, so a re-run after a failure redoes only the rest.
// 4. The directory is removed (prune-tmp clears one a killed run leaves).
//
// Node built-ins only: the deploy workflow runs no npm install.
const { spawn, execFileSync } = require("child_process");
const { join } = require("path");
const { TMP_DIRECTORY } = require("./constants");

const ROOT = join(__dirname, "../..");
const FOLDERS = "app/templates/folders";
const UNIT = process.env.BLOT_DEMO_FOLDERS_UNIT || "blot-blue";
const MARKER = "$HOME/demo-folders.json";

const TARGET = process.env.BLOT_DEPLOY_TARGET || "blot";
if (!/^[A-Za-z0-9._@-]+$/.test(TARGET) || TARGET.startsWith("-")) {
  console.error(
    `Invalid BLOT_DEPLOY_TARGET '${TARGET}': use an ssh alias or user@host`
  );
  process.exit(1);
}

function git(...args) {
  return execFileSync("git", ["-C", ROOT, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  }).trim();
}

// Runs command on the host. input is written to its stdin: a string, or a
// readable stream. Resolves to its stdout, rejects if it exits non-zero.
// stderr and, with inherit, stdout are shown as they arrive.
function ssh(command, { input, inherit } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("ssh", [TARGET, command], {
      stdio: ["pipe", inherit ? "inherit" : "pipe", "inherit"],
    });
    let stdout = "";

    if (child.stdout) child.stdout.on("data", (data) => (stdout += data));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve(stdout)
        : reject(new Error(`ssh exited ${code}: ${command}`))
    );

    if (input && typeof input.pipe === "function") input.pipe(child.stdin);
    else child.stdin.end(input || "");
  });
}

// { name: tree hash } for the demo folders at commit, skipping names that
// start with - or . as the build does
function treeHashes(commit) {
  const hashes = {};
  for (const line of git("ls-tree", commit, FOLDERS + "/").split("\n")) {
    const match = /^\d+ tree ([0-9a-f]+)\t.+\/([^/]+)$/.exec(line);
    if (match && !/^[-.]/.test(match[2])) hashes[match[2]] = match[1];
  }
  return hashes;
}

async function readMarker() {
  const text = await ssh(`cat ${MARKER} 2>/dev/null || true`);
  try {
    return text.trim() ? JSON.parse(text) : {};
  } catch (err) {
    console.log("Ignoring an unreadable marker:", err.message);
    return {};
  }
}

function writeMarker(marker) {
  return ssh(`cat > ${MARKER}.new && mv ${MARKER}.new ${MARKER}`, {
    input: JSON.stringify(marker, null, 2) + "\n",
  });
}

// Sends the folders at commit to dir in the unit, as git archive's tar of
// them. The deploy workflow's checkout is sparse and fetches no blobs it
// doesn't check out, so add the folders to it first: a checkout fetches
// their blobs in one batch, where git archive would fetch them one by one.
async function send(commit, names, dir) {
  if (git("config", "--bool", "core.sparseCheckout") === "true") {
    git("sparse-checkout", "add", ...names.map((name) => FOLDERS + "/" + name));
  }

  const archive = spawn(
    "git",
    ["-C", ROOT, "archive", "--format=tar", commit + ":" + FOLDERS, ...names],
    { stdio: ["ignore", "pipe", "inherit"] }
  );
  const archived = new Promise((resolve, reject) => {
    archive.on("error", reject);
    archive.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`git archive exited ${code}`))
    );
  });

  await Promise.all([
    ssh(
      `docker exec -i -u 1000 ${UNIT} sh -c 'rm -rf ${dir} && mkdir -p ${dir} && tar -x -C ${dir}'`,
      { input: archive.stdout }
    ),
    archived,
  ]);
}

async function main() {
  const commit = git(
    "rev-parse",
    "--verify",
    (process.argv[2] || "HEAD") + "^{commit}"
  );
  const hashes = treeHashes(commit);
  const marker = await readMarker();
  const changed = Object.keys(hashes).filter(
    (name) => marker[name] !== hashes[name]
  );

  if (!changed.length) {
    console.log("Demo folders: none changed since the last sync");
    return;
  }

  console.log("Demo folders to sync:", changed.join(", "));

  const dir = `${TMP_DIRECTORY}/demo-folders/${commit}`;
  const failed = [];

  try {
    await send(commit, changed, dir);

    for (const name of changed) {
      try {
        await ssh(
          `docker exec -u 1000 ${UNIT} timeout 1800 node app/templates/folders/index.js --from ${dir} --only ${name} --zip`,
          { inherit: true }
        );
        marker[name] = hashes[name];
        await writeMarker(marker);
        console.log("Demo folder synced:", name);
      } catch (err) {
        console.error("Demo folder failed:", name, err.message);
        failed.push(name);
      }
    }
  } finally {
    await ssh(`docker exec -u 1000 ${UNIT} rm -rf ${dir}`).catch((err) =>
      console.error("Could not remove", dir, err.message)
    );
  }

  if (failed.length) {
    throw new Error("Demo folders failed: " + failed.join(", "));
  }
}

(async () => {
  try {
    await main();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
})();
