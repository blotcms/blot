// One-time backfill: deletes the Google Drive records Blot still keeps for
// blogs no longer connected to Google Drive, because they were deleted or
// moved to another client. Drive's disconnect (clients/google-drive/
// forget.js) now deletes all of a blog's Drive data, and deleting a blog
// connected to Drive disconnects it, so new ones shouldn't appear; these were
// left by earlier disconnects, which deleted only the account record and the
// folder mapping, or by one that failed part way.
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

// "deleted", "on <client>", "connected", or "unclear" when the three
// checks for a deleted blog disagree
async function stateOf(blogID) {
  const [blog, member, info] = await Promise.all([
    Blog.get({ id: blogID }),
    client.sIsMember(blogKey.ids, blogID),
    client.exists(blogKey.info(blogID)),
  ]);
  if (!blog) return !member && !info ? "deleted" : "unclear";
  if (blog.client === "google-drive") return "connected";
  return `on ${blog.client || "no client"}`;
}

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
    .filter(([, state]) => state === "deleted" || state.startsWith("on "))
    .map(([blogID]) => blogID);

  // Folders named by accounts that stay, whose mapping must stay too
  const liveFolders = new Set();
  await database.blog.iterate(async (blogID, account) => {
    if (!dangling.includes(blogID) && account.folderId)
      liveFolders.add(account.folderId);
  });

  const counts = {};
  for (const state of states.values()) counts[state] = (counts[state] || 0) + 1;
  console.log(
    `${found.size} blog ids referred to by Google Drive records:`,
    JSON.stringify(counts),
    "\n"
  );
  for (const [blogID, state] of states)
    if (state === "unclear")
      console.log(
        `${blogID}: left alone, the checks for a deleted blog disagree`
      );

  for (const blogID of dangling) {
    const account = await database.blog.get(blogID);
    const folder = account?.folderId
      ? liveFolders.has(account.folderId)
        ? "folder mapping kept: a live account names the same folder"
        : "folder mapping deleted"
      : "no folder";
    console.log(
      `${blogID} (${states.get(blogID)}): ${account ? "account record" : "no account record"}` +
        (account?.preparing ? ", setup never finished" : "") +
        `, ${folder}`
    );
    for (const what of found.get(blogID)) console.log(`  ${what}`);

    if (!apply) continue;

    await forget(blogID);
    for (const key of accountSets) await client.sRem(key, blogID);
    await client.sRem(`${PREFIX}blogs`, blogID);
    const own = checksumKeys
      .filter((entry) => entry.blogID === blogID)
      .map((entry) => entry.key);
    if (own.length) await client.del(own);
    console.log("  deleted");
  }

  console.log(
    `\n${apply ? "Deleted" : "Dry run: would delete"} the Google Drive records of ${dangling.length} blogs`
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
