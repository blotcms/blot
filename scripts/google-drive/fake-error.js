// Exercise Google Drive API error states locally without touching Drive.
//
//   docker exec -it blot-node-app-1 node scripts/google-drive/fake-error.js modes
//   docker exec -it blot-node-app-1 node scripts/google-drive/fake-error.js run <mode> <blogID> [--keep]
//   docker exec -it blot-node-app-1 node scripts/google-drive/fake-error.js health <blogID>
//   docker exec -it blot-node-app-1 node scripts/google-drive/fake-error.js on <mode>
//   docker exec -it blot-node-app-1 node scripts/google-drive/fake-error.js off
//   docker exec -it blot-node-app-1 node scripts/google-drive/fake-error.js status
//
// `run` syncs one connected blog in this process while the folder lookup
// returns the chosen error (see scripts/development/fake-google-drive-errors.js),
// prints the resulting getHealth(), then restores the blog's Google Drive
// row so you can run the next mode. A "lost folder" mode clears folderId, so
// without the restore you would have to redo setup between runs; pass --keep
// to leave the resulting state in place and inspect it on the dashboard.
//
// `on`/`off` instead toggle the mode for the running dev app (which preloads
// the same file via docker-compose.yml), so webhooks and polling hit it too.

const fs = require("fs");
const {
  MODES,
  flagPath,
} = require("../development/fake-google-drive-errors");

const [command, ...args] = process.argv.slice(2);
const positional = args.filter((arg) => !arg.startsWith("--"));

function usage() {
  console.error(
    "Usage: node scripts/google-drive/fake-error.js modes|run <mode> <blogID> [--keep]|health <blogID>|on <mode>|off|status"
  );
  process.exit(1);
}

function requireMode(mode) {
  if (!MODES[mode]) {
    console.error("Unknown mode:", mode || "(none)");
    console.error("Modes:", Object.keys(MODES).join(", "));
    process.exit(1);
  }
}

async function health(blogID) {
  const getHealth = require("clients/google-drive/getHealth");
  const result = await getHealth(blogID);
  console.log("getHealth:", JSON.stringify(result, null, 2));
}

// Put the row back exactly as it was, removing fields the run added
async function restore(database, blogID, before) {
  const current = (await database.blog.get(blogID)) || {};
  const patch = {};
  Object.keys(current).forEach((key) => {
    if (!(key in before)) patch[key] = null;
  });
  Object.assign(patch, before);
  await database.blog.store(blogID, patch);
}

async function run(mode, blogID, keep) {
  requireMode(mode);
  if (!blogID) usage();

  process.env.BLOT_FAKE_DRIVE_ERROR = mode;

  const database = require("clients/google-drive/database");
  const sync = require("clients/google-drive/sync");
  const before = await database.blog.get(blogID);

  if (!before || !before.folderId) {
    console.error(blogID, "has no connected Google Drive folder");
    process.exit(1);
  }

  console.log("Mode:", mode, "-", MODES[mode].expect);
  const result = await sync(blogID);
  console.log("sync returned:", result);

  const after = await database.blog.get(blogID);
  console.log(
    "row:",
    JSON.stringify({
      folderId: after.folderId,
      error: after.error,
      errorCode: after.errorCode,
      errorSince: after.errorSince,
    })
  );
  await health(blogID);

  if (keep) {
    console.log("Left the resulting state in place (--keep).");
  } else {
    await restore(database, blogID, before);
    console.log("Restored the original Google Drive row.");
  }
}

async function main() {
  if (command === "modes") {
    Object.keys(MODES).forEach((mode) =>
      console.log(mode.padEnd(16), MODES[mode].expect)
    );
  } else if (command === "run") {
    await run(positional[0], positional[1], args.includes("--keep"));
  } else if (command === "health") {
    if (!positional[0]) usage();
    await health(positional[0]);
  } else if (command === "on") {
    requireMode(positional[0]);
    fs.writeFileSync(flagPath, positional[0]);
    console.log("Fake Google Drive folder-lookup error: ON (" + positional[0] + ")");
  } else if (command === "off") {
    fs.rmSync(flagPath, { force: true });
    console.log("Fake Google Drive folder-lookup error: OFF");
  } else if (command === "status") {
    console.log(
      "Fake Google Drive folder-lookup error:",
      fs.existsSync(flagPath) ? "ON (" + fs.readFileSync(flagPath, "utf8") + ")" : "OFF"
    );
  } else {
    usage();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
