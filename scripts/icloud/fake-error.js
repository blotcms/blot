// Exercise iCloud error states locally without a macserver or iCloud.
//
//   docker exec -it blot-node-app-1 node scripts/icloud/fake-error.js modes
//   docker exec -it blot-node-app-1 node scripts/icloud/fake-error.js run <mode> <blogID> [--keep]
//   docker exec -it blot-node-app-1 node scripts/icloud/fake-error.js health <blogID>
//
// iCloud errors are written by the macserver (posting to routes/site/status.js)
// and by the server's own setup and transfer code, all through
// database.store(). `run` writes the same fields for the chosen mode onto a
// connected blog's iCloud row, prints the resulting row and getHealth(), then
// restores the row so you can run the next mode. Pass --keep to leave the
// state in place and look at it on the dashboard.

const config = require("config");
const client = require("models/client");
const database = require("clients/icloud/database");
const { BLOG_DIRECTORY_DELETED } = require("clients/icloud/error");

const SETUP = { setupComplete: false, transferringToiCloud: false };

// What each writer leaves on the row. `legacy` modes drop the code, as rows
// written before errorCode existed (or by an older macserver) have none.
const MODES = {
  "folder-missing": {
    expect: "error: SOURCE_MISSING (watcher saw the folder deleted)",
    fields: {
      setupComplete: true,
      error: BLOG_DIRECTORY_DELETED,
      errorCode: "SOURCE_MISSING",
    },
  },
  "legacy-folder-missing": {
    expect: "error: SOURCE_MISSING, inferred from a row with no errorCode",
    fields: { setupComplete: true, error: BLOG_DIRECTORY_DELETED },
    dropCode: true,
  },
  "transfer-failed": {
    expect: "error: TRANSFER_INCOMPLETE (initial transfer to iCloud failed)",
    fields: Object.assign({}, SETUP, {
      acceptedSharingLink: true,
      error: "Request failed after 3 retries",
      errorCode: "TRANSFER_INCOMPLETE",
    }),
  },
  "setup-failed": {
    expect: "ok, no health issue (the dashboard shows the setup failure)",
    fields: Object.assign({}, SETUP, {
      acceptedSharingLink: false,
      error: "Invalid sharing link",
      errorCode: "SETUP_FAILED",
    }),
  },
  "legacy-setup-failed": {
    expect: "ok, inferred as a setup failure from a row with no errorCode",
    fields: Object.assign({}, SETUP, {
      acceptedSharingLink: false,
      error: "Invalid sharing link",
    }),
    dropCode: true,
  },
  "setting-up": {
    expect: "syncing (initial transfer running)",
    fields: Object.assign({}, SETUP, {
      transferringToiCloud: true,
      error: null,
    }),
  },
  healthy: {
    expect: "ok (a set-up blog with no error)",
    fields: { setupComplete: true, transferringToiCloud: false, error: null },
  },
};

// This overwrites a real blog's iCloud row, so it is for local development
if (config.environment !== "development") {
  console.error("scripts/icloud/fake-error.js only runs in development");
  process.exit(1);
}

const [command, ...args] = process.argv.slice(2);
const positional = args.filter((arg) => !arg.startsWith("--"));

function usage() {
  console.error(
    "Usage: node scripts/icloud/fake-error.js modes|run <mode> <blogID> [--keep]|health <blogID>"
  );
  process.exit(1);
}

async function health(blogID) {
  const getHealth = require("clients/icloud/getHealth");
  console.log("getHealth:", JSON.stringify(await getHealth(blogID), null, 2));
}

// Put the row back exactly as it was, field by field, so a legacy row stays
// legacy (database.store() would classify it)
async function restore(blogID, before) {
  const key = database._key(blogID);
  await client.del(key);
  for (const [field, value] of Object.entries(before)) {
    await client.hSet(key, field, JSON.stringify(value));
  }
}

async function run(mode, blogID, keep) {
  if (!MODES[mode]) {
    console.error("Unknown mode:", mode || "(none)");
    console.error("Modes:", Object.keys(MODES).join(", "));
    process.exit(1);
  }
  if (!blogID) usage();

  const before = await database.get(blogID);

  if (!before) {
    console.error(blogID, "has no connected iCloud account");
    process.exit(1);
  }

  console.log("Mode:", mode, "-", MODES[mode].expect);

  try {
    // Start from a clear error so errorSince is stamped fresh
    await database.store(blogID, { error: null });
    await database.store(blogID, MODES[mode].fields);

    if (MODES[mode].dropCode) {
      await client.hDel(database._key(blogID), ["errorCode", "errorSince"]);
    }

    const after = await database.get(blogID);
    console.log(
      "row:",
      JSON.stringify({
        setupComplete: after.setupComplete,
        acceptedSharingLink: after.acceptedSharingLink,
        transferringToiCloud: after.transferringToiCloud,
        error: after.error,
        errorCode: after.errorCode,
        errorSince: after.errorSince,
      })
    );
    await health(blogID);
  } finally {
    if (keep) {
      console.log("Left the resulting state in place (--keep).");
    } else {
      await restore(blogID, before);
      console.log("Restored the original iCloud row.");
    }
  }
}

async function main() {
  if (command === "modes") {
    Object.keys(MODES).forEach((mode) =>
      console.log(mode.padEnd(22), MODES[mode].expect)
    );
  } else if (command === "run") {
    await run(positional[0], positional[1], args.includes("--keep"));
  } else if (command === "health") {
    if (!positional[0]) usage();
    await health(positional[0]);
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
