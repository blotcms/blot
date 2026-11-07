// Read the whole blog folder into the database. Runs INSIDE the container.
//
//   docker exec blot-node-app-1 node scripts/development/translate/rescan <blogID>
//
// The folder watcher cannot be relied on for content the maintainer drops in:
// app/clients/local/setup.js starts chokidar with `ignoreInitial: true`, and
// setup only runs after `sync/fix` completes, so anything copied in before the
// watcher is listening is never seen. `sync/fix` does not help either — it only
// removes ghosts of files that have gone, it does not discover new ones.
//
// So rather than waiting and hoping, walk the folder and update every path
// explicitly. This is the same mechanism app/templates/folders/index.js uses to
// load the demo folders.

const { promisify } = require("util");
const { posix } = require("path");

const sync = require("sync");
const folder = require("storage/folder");
const shouldIgnoreFile = require("clients/util/shouldIgnoreFile");

// Directories that never contain entries. Templates are built by
// buildFromFolder on sync release, and .verification / .git are ours.
const SKIP_DIRECTORIES = new Set([".git", ".verification", "node_modules"]);

async function walk(blogID, directory = "/", found = []) {
  let items;

  try {
    items = await folder.listNames(blogID, directory);
  } catch (e) {
    return found;
  }

  for (const item of items) {
    const full = posix.join(directory, item.name);

    if (item.isDirectory) {
      if (SKIP_DIRECTORIES.has(item.name)) continue;
      await walk(blogID, full, found);
      continue;
    }

    if (shouldIgnoreFile(item.name)) continue;

    // Blot wants leading slashes and forward slashes.
    found.push(full);
  }

  return found;
}

// The watcher takes the same folder lock for every file event it processes, and
// sync gives up after a few retries of its own. Dropping a directory of content
// in can keep it busy for far longer than that, so wait the watcher out rather
// than failing the scan.
const LOCK_ATTEMPTS = 10;
const LOCK_RETRY_DELAY = 4000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function rescanWithRetry(blogID) {
  let lastError;

  for (let attempt = 1; attempt <= LOCK_ATTEMPTS; attempt++) {
    try {
      // Content the maintainer dropped into the Local client's source directory
      // reaches the folder first (the watcher ignores what it didn't see)
      await require("clients/local/setup").reconcileSource(blogID);
      return await rescanOnce(blogID);
    } catch (err) {
      lastError = err;

      // Only a busy folder is worth waiting for; anything else is a real error.
      if (!/lock/i.test(err.message || "")) throw err;

      if (attempt < LOCK_ATTEMPTS) await sleep(LOCK_RETRY_DELAY);
    }
  }

  throw lastError;
}

function rescanOnce(blogID) {
  return new Promise((resolve, reject) => {
    sync(blogID, async function (err, folder, done) {
      if (err) return reject(err);

      const update = promisify(folder.update);
      let paths = [];
      let updated = 0;
      let failed = 0;

      try {
        paths = await walk(blogID);

        for (const path of paths) {
          try {
            await update(path);
            updated++;
          } catch (e) {
            // One unreadable or unconvertible file should not abandon the scan.
            failed++;
          }
        }
      } catch (e) {
        return done(e, () => reject(e));
      }

      done(null, () => resolve({ total: paths.length, updated, failed }));
    });
  });
}

if (require.main === module) {
  const blogID = process.argv[2];

  if (!blogID) {
    console.error("Usage: node rescan.js <blogID>");
    process.exit(1);
  }

  rescanWithRetry(blogID)
    .then((result) => {
      console.log(`files=${result.total}`);
      console.log(`updated=${result.updated}`);
      console.log(`failed=${result.failed}`);
      process.exit(0);
    })
    .catch((err) => {
      console.error("[rescan]", err.message);
      process.exit(1);
    });
}

module.exports = rescanWithRetry;
module.exports.once = rescanOnce;
