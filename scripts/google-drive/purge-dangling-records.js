// One-time backfill: deletes the Google Drive records Blot still keeps for
// blogs no longer connected to Google Drive, because they were deleted or
// moved to another client. Drive's disconnect (clients/google-drive/
// forget.js) now deletes all of a blog's Drive data, connecting another
// client disconnects Drive first (clients/util/setClient.js), deleting a blog
// connected to Drive disconnects it, and background writes no longer bring
// back a deleted account record (database/blog.js: update). These were left
// before that.
//
// A record is dangling when its blog:
//   - is deleted: Blog.get finds nothing, the blog is not in the set of blog
//     ids, and it has no info key (all three must agree; a blog where they
//     disagree is reported and left alone); or
//   - exists, but its client is not google-drive. Connecting sets the client
//     before the account record is written, so a record beside another
//     client is never a setup in progress.
//
// Looks for blog ids in:
//   - blot:google-drive:blogs (the set of Drive accounts), and every
//     blot:google-drive:blogs:<blogID> account hash;
//   - every blot:google-drive:serviceAccountId:<id> set;
//   - the per-blog dirty keys (dirty-dirs, dirty-seen, moved-folders);
//   - the per-blog checksum hashes <folderId>:verified-content:<blogID> and
//     <folderId>:applied-modified-time:<blogID>.
// It checks each key's TYPE before reading it.
//
// A blog whose setup started in the last two hours is left alone, and each
// blog's state is checked again just before its records are deleted.
//
// For each dangling blog, --apply runs forget.js (the account hash, its set
// memberships, the dirty keys, and the folder's mapping unless an account
// that stays names the same folder), removes the blog from every account
// set, and deletes its per-blog checksum hashes under any folder. Nothing in
// Drive, and nothing in the blog's folder, is touched. Every step can run
// again, so a run that stops part way is finished by running it again.
//
// Usage:
//   node scripts/google-drive/purge-dangling-records.js           # dry run
//   node scripts/google-drive/purge-dangling-records.js --apply
const apply = process.argv.slice(2).includes("--apply");

const client = require("models/client");
const Blog = require("models/blog");
const blogKey = require("models/blog/key");
const PREFIX = require("clients/google-drive/database/prefix");
const database = require("clients/google-drive/database");
const forget = require("clients/google-drive/forget");

const BLOG_ID = /^blog_[a-f0-9]+$/;
const SCAN_COUNT = 1000;

async function scan(pattern, type) {
  const keys = [];
  let cursor = "0";
  do {
    const res = await client.scan(cursor, {
      MATCH: pattern,
      COUNT: SCAN_COUNT,
    });
    cursor = String(res.cursor);
    keys.push(...res.keys);
  } while (cursor !== "0");

  const typed = [];
  for (const key of keys) {
    const found = await client.type(key);
    if (found === type) typed.push(key);
    else console.log(`Skipping ${key}: type ${found}, expected ${type}`);
  }
  return typed;
}

const SETUP_TIMEOUT_MS = 2 * 60 * 60 * 1000; // as routes/setup.js
const RECENT_MS = 24 * 60 * 60 * 1000;

// { state, detail }: state is "deleted", "on <client>", "connected", or
// "unclear" when the three checks for a deleted blog disagree
async function stateOf(blogID) {
  const [blog, member, info] = await Promise.all([
    Blog.get({ id: blogID }),
    client.sIsMember(blogKey.ids, blogID),
    client.exists(blogKey.info(blogID)),
  ]);
  if (!blog) {
    if (!member && !info) return { state: "deleted" };
    return {
      state: "unclear",
      detail: `Blog.get found nothing, in the blog id set: ${member}, info key: ${Boolean(info)}`,
    };
  }
  if (blog.client === "google-drive") return { state: "connected" };
  return { state: `on ${blog.client || "no client"}` };
}

const isDangling = (state) => state === "deleted" || state.startsWith("on ");

// A setup started in the last two hours: someone may be connecting right now
const settingUp = (account) =>
  Boolean(account?.preparing) &&
  Date.now() - Number(account.startedSetup || 0) < SETUP_TIMEOUT_MS;

// A stored time as ISO, or as stored when it isn't one (old records hold
// strings)
const when = (value) => {
  if (!value) return "never";
  const date = new Date(Number.isFinite(Number(value)) ? Number(value) : value);
  return Number.isNaN(date.getTime())
    ? JSON.stringify(value)
    : date.toISOString();
};

async function main() {
  // blogID -> what refers to it
  const found = new Map();
  const note = (blogID, what) => {
    if (!BLOG_ID.test(blogID)) return;
    if (!found.has(blogID)) found.set(blogID, []);
    found.get(blogID).push(what);
  };

  for (const blogID of await client.sMembers(`${PREFIX}blogs`))
    note(blogID, `member of ${PREFIX}blogs`);

  for (const key of await scan(`${PREFIX}blogs:*`, "hash"))
    note(key.slice(`${PREFIX}blogs:`.length), key);

  const accountSets = await scan(`${PREFIX}serviceAccountId:*`, "set");
  for (const key of accountSets)
    for (const blogID of await client.sMembers(key))
      note(blogID, `member of ${key}`);

  for (const [name, type] of [
    ["dirty-dirs", "set"],
    ["dirty-seen", "hash"],
    ["moved-folders", "hash"],
  ]) {
    for (const key of await scan(`${PREFIX}${name}:*`, type))
      note(key.slice(`${PREFIX}${name}:`.length), key);
  }

  const checksumKeys = [];
  for (const name of ["verified-content", "applied-modified-time"]) {
    for (const key of await scan(`${PREFIX}*:${name}:blog_*`, "hash")) {
      const blogID = key.slice(key.lastIndexOf(":") + 1);
      checksumKeys.push({ key, blogID });
      note(blogID, key);
    }
  }

  const states = new Map();
  for (const blogID of found.keys()) states.set(blogID, await stateOf(blogID));
  const dangling = [...states]
    .filter(([, { state }]) => isDangling(state))
    .map(([blogID]) => blogID);

  // Folders named by accounts that stay, whose mapping must stay too
  const liveFolders = new Set();
  const accountsOf = new Map();
  await database.blog.iterate(async (blogID, account) => {
    accountsOf.set(blogID, account.folderId);
    if (!dangling.includes(blogID) && account.folderId)
      liveFolders.add(account.folderId);
  });

  const counts = {};
  for (const { state } of states.values())
    counts[state] = (counts[state] || 0) + 1;
  console.log(
    `${found.size} blog ids referred to by Google Drive records:`,
    JSON.stringify(counts),
    "\n"
  );
  for (const [blogID, { state, detail }] of states)
    if (state === "unclear") console.log(`${blogID}: left alone, ${detail}`);

  let recentlySynced = 0;
  let purged = 0;

  for (const blogID of dangling) {
    const account = await database.blog.get(blogID);
    const sharers = account?.folderId
      ? dangling.filter(
          (other) =>
            other !== blogID && accountsOf.get(other) === account.folderId
        )
      : [];
    const folder = !account?.folderId
      ? "no folder"
      : liveFolders.has(account.folderId)
        ? "folder mapping kept: an account that stays names the same folder"
        : sharers.length
          ? `folder mapping deleted with the last of these: ${sharers.join(" ")}`
          : "folder mapping deleted";
    const { state } = states.get(blogID);
    const synced = Date.now() - Number(account?.lastSync || 0) < RECENT_MS;
    if (account && synced && state !== "deleted") recentlySynced += 1;

    console.log(
      `${blogID} (${state}): ${account ? "account record" : "no account record"}, ${folder}`
    );
    if (account)
      console.log(
        `  folderId=${account.folderId || "none"} serviceAccountId=${account.serviceAccountId || "none"}` +
          ` preparing=${Boolean(account.preparing)} startedSetup=${when(account.startedSetup)}` +
          ` lastSync=${when(account.lastSync)} latestDriveActivity=${when(account.latestDriveActivityTimestamp)}` +
          ` fields=${Object.keys(account).sort().join(",")}`
      );
    for (const what of found.get(blogID)) console.log(`  ${what}`);

    if (settingUp(account)) {
      console.log("  left alone: a setup started in the last two hours");
      continue;
    }

    if (!apply) {
      purged += 1;
      continue;
    }

    // Again, just before deleting: the blog may have connected to Drive
    // since the scan
    const now = await stateOf(blogID);
    if (!isDangling(now.state)) {
      console.log(`  left alone: now ${now.state}`);
      continue;
    }
    if (settingUp(await database.blog.get(blogID))) {
      console.log("  left alone: a setup has started since the scan");
      continue;
    }

    await forget(blogID);
    for (const key of accountSets) await client.sRem(key, blogID);
    await client.sRem(`${PREFIX}blogs`, blogID);
    const own = checksumKeys
      .filter((entry) => entry.blogID === blogID)
      .map((entry) => entry.key);
    if (own.length) await client.del(own);
    purged += 1;
    console.log("  deleted");
  }

  console.log(
    `\n${recentlySynced} of these blogs, still existing, had a Google Drive sync in the last day`
  );
  console.log(
    apply
      ? `Deleted the Google Drive records of ${purged} of ${dangling.length} blogs`
      : `Dry run: would delete the Google Drive records of ${purged} of ${dangling.length} blogs`
  );
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("Purge failed:", err);
      process.exit(1);
    });
}
