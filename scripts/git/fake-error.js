// Exercise Git health states locally without breaking a real repository.
// Git's error state is a per-blog Redis record, so nothing needs preloading
// into the running app.
//
//   docker exec -it blot-node-app-1 node scripts/git/fake-error.js set SOURCE_MISSING <blogID>
//   docker exec -it blot-node-app-1 node scripts/git/fake-error.js set SYNC_ERROR <blogID>
//   docker exec -it blot-node-app-1 node scripts/git/fake-error.js set create-failed <blogID>
//   docker exec -it blot-node-app-1 node scripts/git/fake-error.js clear <blogID>
//   docker exec -it blot-node-app-1 node scripts/git/fake-error.js health <blogID>
//
// SYNC_ERROR is the rejected-push case (symlinks or submodules); it has no
// dashboard action button. create-failed is a failed repository setup, which
// links back to /create. Note getHealth also checks the token and repos on
// disk, so a blog without a live repository reports SOURCE_MISSING anyway.

const { promisify } = require("util");
const health = require("clients/health");
const database = require("clients/git/database");
const { MESSAGES } = require("clients/git/error");

const setIssue = promisify(database.setIssue);
const clearIssue = promisify(database.clearIssue);
const setStatus = promisify(database.setStatus);

const [command, ...args] = process.argv.slice(2);

const ISSUES = {
  SOURCE_MISSING: {
    code: health.CODES.SOURCE_MISSING,
    message: MESSAGES.SOURCE_MISSING,
  },
  SYNC_ERROR: {
    code: health.CODES.SYNC_ERROR,
    message: MESSAGES.TREE_REJECTED,
  },
};

function usage() {
  console.error(
    "Usage: node scripts/git/fake-error.js set <SOURCE_MISSING|SYNC_ERROR|create-failed> <blogID>|clear <blogID>|health <blogID>"
  );
  process.exit(1);
}

async function show(blogID) {
  const getHealth = require("clients/git/getHealth");
  console.log("getHealth:", JSON.stringify(await getHealth(blogID), null, 2));
}

async function main() {
  const blogID = command === "set" ? args[1] : args[0];
  if (!blogID) usage();

  if (command === "set") {
    if (args[0] === "create-failed") {
      await setStatus(blogID, database.STATUSES.CREATE_FAILED);
    } else if (ISSUES[args[0]]) {
      await setIssue(blogID, ISSUES[args[0]]);
    } else {
      usage();
    }
    await show(blogID);
  } else if (command === "clear") {
    await clearIssue(blogID);
    await setStatus(blogID, database.STATUSES.CREATE_COMPLETE);
    console.log("Cleared the Git issue for", blogID);
  } else if (command === "health") {
    await show(blogID);
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
