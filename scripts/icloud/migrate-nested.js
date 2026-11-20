// Moves iCloud blogs to the nested folder layout on the macserver
// (app/clients/icloud/macserver/blogFolder.js, #2874), so each blog's folder
// keeps its owner's name and the dashboard can show it as they rename it.
//
// For each connected blog still in the old layout, the macserver checks the
// share (still shared with Blot, may make changes), leaves it, opens the
// stored sharing link again, nests the folder in blog_<id>, and asks Blot for
// a resync from iCloud. Already-nested blogs are skipped, so the script can
// be run again after a stop.
//
// Dry run by default: lists what each blog would get, and changes nothing.
//
//   node scripts/icloud/migrate-nested.js                  # dry run, every blog
//   node scripts/icloud/migrate-nested.js --apply --blog icloudtest
//   node scripts/icloud/migrate-nested.js --apply --limit 5
//
// Each blog's sync lock is held while it moves: until iCloud lists the
// rejoined folder's files again, a validation or resync walking it would
// remove the files not listed yet from the site. The macserver's resync
// request at the end gets "locked" and retries until the lock is released.
//
// --apply stops at the first failure: a failed rejoin may leave that blog
// without its folder on the macserver until it is set up again.

const config = require("config");
const Blog = require("models/blog");
const hold = require("sync/hold");
const database = require("clients/icloud/database");
const { shouldSkipBackgroundSync } = require("clients/icloud/error");
const fetch = require("clients/icloud/util/rateLimitedFetchWithRetriesAndTimeout");

const MACSERVER_URL = config.icloud.server_address;
const MACSERVER_AUTH = config.icloud.secret;

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const option = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1];
};
const onlyBlog = option("--blog");
const limit = parseInt(option("--limit") || "0", 10) || Infinity;
// Time for each blog's resync before the next blog is moved
const pauseMs = parseInt(option("--pause") || "60000", 10);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const macserver = async (method, path, headers, timeout) => {
  const response = await fetch(`${MACSERVER_URL}${path}`, {
    method,
    timeout,
    retries: 1,
    headers: Object.assign({ Authorization: MACSERVER_AUTH }, headers),
  });
  return response.json();
};

const main = async () => {
  let only = null;
  if (onlyBlog) {
    const blog =
      (await Blog.get({ id: onlyBlog })) ||
      (await Blog.get({ handle: onlyBlog }));
    if (!blog) throw new Error(`No blog ${onlyBlog}`);
    only = blog.id;
  }

  const candidates = [];
  await database.iterate(async (blogID, account) => {
    if (only && blogID !== only) return;
    candidates.push({ blogID, account });
  });

  const tally = {};
  const count = (what) => (tally[what] = (tally[what] || 0) + 1);
  let moved = 0;

  for (const { blogID, account } of candidates) {
    if (moved >= limit) break;

    if (shouldSkipBackgroundSync(account) || !account.sharingLink) {
      count("skipped: not set up, or an error stored");
      continue;
    }

    let layout;
    try {
      layout = await macserver("GET", "/layout", { blogID }, 30000);
    } catch (error) {
      console.error(`${blogID}: could not read its layout:`, error.message);
      count("skipped: layout unreadable");
      continue;
    }

    if (!layout.exists) {
      count("skipped: no folder on the macserver");
      continue;
    }
    if (layout.nested) {
      count("already nested");
      continue;
    }
    if (layout.permission !== "readWrite") {
      console.log(`${blogID}: share permission is ${layout.permission}`);
      count(`skipped: permission ${layout.permission}`);
      continue;
    }

    if (!apply) {
      count("would migrate");
      continue;
    }

    console.log(`${blogID}: migrating`);
    let result;
    try {
      result = await hold(blogID, () =>
        macserver(
          "POST",
          "/migrate",
          { blogID, sharingLink: account.sharingLink },
          // the macserver retries the rejoin for about four minutes, then
          // waits up to 30 minutes for the folder's files to be listed
          45 * 60 * 1000
        )
      );
    } catch (error) {
      // A sync was running: nothing was changed, so try the next blog
      if (error.message.startsWith("Failed to acquire folder lock")) {
        console.log(`${blogID}: busy syncing, skipped`);
        count("skipped: lock busy");
        continue;
      }
      console.error(`${blogID}: MIGRATION FAILED:`, error.message);
      console.error(
        "Stopping. Check this blog's folder on the macserver before going on."
      );
      count("failed");
      break;
    }

    console.log(
      `${blogID}: nested as "${result.folderName}"${result.sameShare ? "" : " — ANOTHER SHARE CAME BACK, check it"}`
    );
    count(result.sameShare ? "migrated" : "migrated, other share");
    moved++;
    if (!result.sameShare) break;
    await sleep(pauseMs);
  }

  console.log(apply ? "Done:" : "Dry run:", tally);
};

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
