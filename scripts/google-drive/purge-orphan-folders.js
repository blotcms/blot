// One-time backfill: deletes the records Blot keeps for Google Drive folders
// that no account names any more. A folder's mapping is keyed by the folder
// alone (clients/google-drive/database/folder.js):
//
//   blot:google-drive:<folderId>:folder, :path and :metadata
//   blot:google-drive:<folderId>:verified-content[:<blogID>]
//   blot:google-drive:<folderId>:applied-modified-time[:<blogID>]
//
// They were left when a sync found the folder trashed, deleted or unshared,
// when a setup failed, and by disconnects before #2905: each cleared the
// account's folderId and kept the mapping. Syncs now forget the folder in the
// first two cases too. purge-dangling-records.js can't find these: it starts
// from blogs, and most of the blogs that wrote them have no records left. This
// starts from the folders instead. It also takes the undefined:* and null:*
// mappings, which no account can name.
//
// A folder is kept while any account names it, whatever the blog's client.
// Setup stores the folderId before it writes any of the folder's mapping
// (routes/setup.js), so a setup in progress is never taken for an orphan. Each
// folder is checked again against every account just before its keys are
// deleted. Keys are deleted with UNLINK, so a large hash doesn't block Redis.
// Nothing in Drive, and nothing in any blog's folder, is touched. A run that
// stops part way is finished by running it again.
//
// Usage:
//   node scripts/google-drive/purge-orphan-folders.js           # dry run
//   node scripts/google-drive/purge-orphan-folders.js --apply
const apply = process.argv.slice(2).includes("--apply");

const client = require("models/client");
const PREFIX = require("clients/google-drive/database/prefix");

const SCAN_COUNT = 1000;

// <folderId>:<kind>[:<blogID>]
const FOLDER_KEY = new RegExp(
  "^" +
    PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
    "([^:]+):(folder|path|metadata|verified-content|applied-modified-time)(?::(blog_[a-f0-9]+))?$"
);

async function scan(pattern) {
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
  return keys;
}

// Every folderId an account names. Reads the account hashes themselves, not
// only the set of accounts, so an account missing from the set still counts.
async function namedFolders() {
  const named = new Set();
  const keys = new Set(
    (await client.sMembers(`${PREFIX}blogs`)).map(
      (id) => `${PREFIX}blogs:${id}`
    )
  );
  for (const key of await scan(`${PREFIX}blogs:*`)) keys.add(key);

  for (const key of keys) {
    const type = await client.type(key);
    if (type === "none") continue;
    if (type !== "hash") {
      console.log(`Skipping ${key}: type ${type}, expected hash`);
      continue;
    }
    const raw = await client.hGet(key, "folderId");
    let folderId = raw;
    try {
      folderId = JSON.parse(raw);
    } catch (err) {}
    if (folderId) named.add(String(folderId));
  }
  return named;
}

const mb = (bytes) => (bytes / 1e6).toFixed(1) + " MB";

async function main() {
  // folderId -> its keys
  const folders = new Map();
  for (const key of await scan(`${PREFIX}*`)) {
    const match = FOLDER_KEY.exec(key);
    if (!match) continue;
    const folderId = match[1];
    if (folderId === "blogs" || folderId === "serviceAccountId") continue;
    if (!folders.has(folderId)) folders.set(folderId, []);
    folders.get(folderId).push(key);
  }

  const named = await namedFolders();
  const orphans = [...folders.keys()].filter((id) => !named.has(id));

  console.log(
    `${folders.size} folders have records, ${named.size} are named by an account, ${orphans.length} are orphaned`
  );

  let totalKeys = 0;
  let totalBytes = 0;
  let deleted = 0;
  let kept = 0;

  for (const folderId of orphans) {
    const keys = [];
    let entries = 0;
    let bytes = 0;
    for (const key of folders.get(folderId)) {
      const type = await client.type(key);
      if (type === "none") continue;
      if (type !== "hash") {
        console.log(`Skipping ${key}: type ${type}, expected hash`);
        continue;
      }
      keys.push(key);
      if (key.endsWith(":folder")) entries = await client.hLen(key);
      bytes += (await client.memoryUsage(key)) || 0;
    }
    if (!keys.length) continue;

    totalKeys += keys.length;
    totalBytes += bytes;
    console.log(
      `${apply ? "Deleting" : "Would delete"} ${folderId}: ${keys.length} keys, ${entries} mapped items, ${mb(bytes)}`
    );

    if (!apply) continue;

    // An account may have named the folder since the scan
    if ((await namedFolders()).has(folderId)) {
      console.log(`Keeping ${folderId}: an account names it now`);
      kept += 1;
      continue;
    }
    await client.unlink(keys);
    deleted += 1;
  }

  console.log(
    apply
      ? `Deleted ${deleted} folders' records (${totalKeys} keys, ${mb(totalBytes)}), kept ${kept}`
      : `Dry run: would delete ${orphans.length} folders' records (${totalKeys} keys, ${mb(totalBytes)}). Run again with --apply to delete them.`
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
