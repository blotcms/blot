// Exercise Dropbox error states locally without touching Dropbox.
//
//   docker exec -it blot-node-app-1 node scripts/dropbox/fake-error.js modes
//   docker exec -it blot-node-app-1 node scripts/dropbox/fake-error.js run <mode> <blogID> [--resync|--reset-from-blot] [--keep]
//   docker exec -it blot-node-app-1 node scripts/dropbox/fake-error.js health <blogID>
//   docker exec -it blot-node-app-1 node scripts/dropbox/fake-error.js on <mode>
//   docker exec -it blot-node-app-1 node scripts/dropbox/fake-error.js off
//   docker exec -it blot-node-app-1 node scripts/dropbox/fake-error.js status
//
// `run` syncs one connected blog in this process (or resyncs it, or resets
// it from Blot) while the chosen error is faked, prints the resulting
// getHealth(), then restores the blog's Dropbox row so you can run the next
// mode. Pass --keep to leave the resulting state in place and inspect it on
// the dashboard.
//
// `on`/`off` instead toggle the mode for the running dev app (which preloads
// scripts/development/fake-dropbox-errors.js via docker-compose.yml), so
// webhooks, dashboard actions and hourly validation hit it too.

const fs = require("fs");
const { promisify } = require("util");
const {
  MODES,
  flagPath,
} = require("../development/fake-dropbox-errors");

const [command, ...args] = process.argv.slice(2);
const positional = args.filter((arg) => !arg.startsWith("--"));

function usage() {
  console.error(
    "Usage: node scripts/dropbox/fake-error.js modes|run <mode> <blogID> [--resync|--reset-from-blot] [--keep]|health <blogID>|on <mode>|off|status"
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
  const getHealth = require("clients/dropbox/getHealth");
  console.log("getHealth:", JSON.stringify(await getHealth(blogID), null, 2));
}

async function run(mode, blogID, flags) {
  requireMode(mode);
  if (!blogID) usage();

  process.env.BLOT_FAKE_DROPBOX_ERROR = mode;

  const database = require("clients/dropbox/database");
  const get = promisify(database.get);
  const set = promisify(database.set);
  const before = await get(blogID);

  if (!before) {
    console.error(blogID, "has no connected Dropbox account");
    process.exit(1);
  }

  console.log("Mode:", mode, "-", MODES[mode].expect);

  try {
    if (flags.includes("--resync")) {
      await require("clients/dropbox/sync/reset-to-blot")(blogID);
    } else if (flags.includes("--reset-from-blot")) {
      await require("clients/dropbox/sync/reset-from-blot")(blogID);
    } else {
      const Blog = require("models/blog");
      const blog = await promisify(Blog.get)({ id: blogID });
      await promisify(require("clients/dropbox/sync"))(blog);
    }
    console.log("completed without throwing");
  } catch (err) {
    console.log("threw:", err && (err.message || err.status || err));
  }

  const after = await get(blogID);
  console.log(
    "row:",
    JSON.stringify({
      error_code: after.error_code,
      error_source: after.error_source,
      error_since: after.error_since,
      cursor: after.cursor === before.cursor ? "(unchanged)" : "(changed)",
    })
  );
  await health(blogID);

  if (flags.includes("--keep")) {
    console.log("Left the resulting state in place (--keep).");
  } else {
    await set(blogID, before);
    console.log("Restored the original Dropbox row.");
  }
}

async function main() {
  if (command === "modes") {
    Object.keys(MODES).forEach((mode) =>
      console.log(mode.padEnd(16), MODES[mode].expect)
    );
  } else if (command === "run") {
    await run(positional[0], positional[1], args.filter((a) => a.startsWith("--")));
  } else if (command === "health") {
    if (!positional[0]) usage();
    await health(positional[0]);
  } else if (command === "on") {
    requireMode(positional[0]);
    fs.writeFileSync(flagPath, positional[0]);
    console.log("Fake Dropbox error: ON (" + positional[0] + ")");
  } else if (command === "off") {
    fs.rmSync(flagPath, { force: true });
    console.log("Fake Dropbox error: OFF");
  } else if (command === "status") {
    console.log(
      "Fake Dropbox error:",
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
