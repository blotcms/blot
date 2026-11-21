// Deletes the Google Drive records Blot still keeps for blogs that no longer
// exist. Blog.remove only ran the client's disconnect, and only for the
// blog's client at the time, so a Drive account record (and its folder
// mapping) could outlive its blog; since this script's PR, Blog.remove calls
// clients/google-drive/forget.js for every deleted blog.
//
// A blog counts as deleted only when all three agree: Blog.get finds nothing,
// the blog is not in the set of blog ids, and it has no info key.
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
// For a deleted blog, --apply runs forget.js (the account hash, its set
// memberships, the dirty keys, and the folder's mapping unless a live
// account names the same folder), removes the blog from every account set,
// and deletes its per-blog checksum hashes under any folder. Nothing in
// Drive is touched. Every step can run again, so a run that stops part way
// is finished by running it again.
//
// Usage:
//   node scripts/google-drive/purge-deleted-blogs.js           # dry run
//   node scripts/google-drive/purge-deleted-blogs.js --apply
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

async function isDeleted(blogID) {
  const [blog, member, info] = await Promise.all([
    Blog.get({ id: blogID }),
    client.sIsMember(blogKey.ids, blogID),
    client.exists(blogKey.info(blogID)),
  ]);
  return !blog && !member && !info;
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

  // Folders named by live accounts, whose mapping must stay
  const liveFolders = new Set();
  const deleted = [];
  for (const blogID of found.keys()) {
    if (await isDeleted(blogID)) deleted.push(blogID);
  }
  await database.blog.iterate(async (blogID, account) => {
    if (!deleted.includes(blogID) && account.folderId)
      liveFolders.add(account.folderId);
  });

  console.log(
    `${found.size} blog ids referred to by Google Drive records, ${deleted.length} of them deleted\n`
  );

  for (const blogID of deleted) {
    const account = await database.blog.get(blogID);
    const folder = account?.folderId
      ? liveFolders.has(account.folderId)
        ? "folder mapping kept: a live account names the same folder"
        : "folder mapping deleted"
      : "no folder";
    console.log(
      `${blogID}: ${account ? "account record" : "no account record"}` +
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
    `\n${apply ? "Deleted" : "Dry run: would delete"} the records of ${deleted.length} deleted blogs`
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
