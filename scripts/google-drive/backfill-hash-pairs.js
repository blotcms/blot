// One-time backfill for #2965: moves what Google Drive's old records knew
// into the per-blog SHA-1 to md5Checksum pairs (clients/google-drive/util/
// hashes.js), then deletes the records nothing reads any more.
//
// For every Drive account:
//   - each verified record (<folderId>:verified-content:<blogID>, by file ID:
//     { path, checksum, sha1, ... }) whose SHA-1 is still the one the folder's
//     index has at its path becomes a pair. A record written before Blot knew
//     the file's SHA-1 ({ ..., size, modified, sha1: null }) becomes one when
//     the index still has the same size and modified time at its path, which
//     is what the sync trusted until #2965, paired with the SHA-1 the index
//     has now. Anything else is dropped: the next walk checks that file
//     through download(), as it would any file without a pair.
//   - each applied record (<folderId>:applied-modified-time:<blogID>) still
//     holding size, modified or fingerprint is rewritten as
//     { modifiedTime, sha1 }. One without a SHA-1 gets the index's, by the
//     same size and modified time check, so a Google Doc isn't exported again.
// Then, across Drive's whole prefix, every verified-content key and every
// <folderId>:metadata hash (written by the mapping, never read) is deleted
// with UNLINK, including those of folders no account names.
//
// Run after the deploy that stops reading the verified records: a walk in
// between checks the files of the blogs it walks through download(), which
// costs reads, not correctness. Each blog's pairs are saved before any key is
// deleted, and every step can run again, so a run that stops part way is
// finished by running it again. Nothing in Drive, and nothing in any blog's
// folder, is touched.
//
// Usage:
//   node scripts/google-drive/backfill-hash-pairs.js           # dry run
//   node scripts/google-drive/backfill-hash-pairs.js --apply
const apply = process.argv.slice(2).includes("--apply");

const client = require("models/client");
const File = require("models/file");
const PREFIX = require("clients/google-drive/database/prefix");
const database = require("clients/google-drive/database");
const hashes = require("clients/google-drive/util/hashes");

const SCAN_COUNT = 1000;
const LEFTOVER_FIELDS = ["size", "modified", "fingerprint"];

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

// The hash at key as { field: parsed JSON }, or null if it isn't a hash
async function readHash(key) {
  const type = await client.type(key);
  if (type === "none") return {};
  if (type !== "hash") {
    console.log(`Skipping ${key}: type ${type}, expected hash`);
    return null;
  }
  const parsed = {};
  for (const [field, value] of Object.entries(await client.hGetAll(key))) {
    try {
      parsed[field] = JSON.parse(value);
    } catch (err) {}
  }
  return parsed;
}

async function backfillBlog(blogID, folderId, totals) {
  const verifiedKey = `${PREFIX}${folderId}:verified-content:${blogID}`;
  const appliedKey = `${PREFIX}${folderId}:applied-modified-time:${blogID}`;

  const verified = await readHash(verifiedKey);
  const known = await hashes.load(blogID);
  let paired = 0;
  let dropped = 0;

  for (const record of Object.values(verified || {})) {
    if (
      !record ||
      typeof record.checksum !== "string" ||
      typeof record.path !== "string"
    ) {
      dropped += 1;
      continue;
    }
    const found = await File.get(blogID, record.path);
    if (!found || found.type !== "file" || !found.sha1) {
      dropped += 1;
      continue;
    }
    const unchanged = record.sha1
      ? found.sha1 === record.sha1
      : Number.isFinite(record.size) &&
        Number.isFinite(record.modified) &&
        found.size === record.size &&
        Math.round(found.modified) === record.modified;
    if (!unchanged) {
      dropped += 1;
      continue;
    }
    known.set(found.sha1, record.checksum);
    paired += 1;
  }

  const applied = await readHash(appliedKey);
  const paths = (await client.hGetAll(`${PREFIX}${folderId}:folder`)) || {};
  const rewrites = [];
  for (const [id, record] of Object.entries(applied || {})) {
    if (!record || typeof record.modifiedTime !== "string") continue;
    if (!LEFTOVER_FIELDS.some((field) => field in record)) continue;
    const slim = { modifiedTime: record.modifiedTime };
    if (typeof record.sha1 === "string" && record.sha1) {
      slim.sha1 = record.sha1;
    } else if (
      paths[id] &&
      Number.isFinite(record.size) &&
      Number.isFinite(record.modified)
    ) {
      const found = await File.get(blogID, paths[id]);
      if (
        found &&
        found.type === "file" &&
        found.sha1 &&
        found.size === record.size &&
        Math.round(found.modified) === record.modified
      )
        slim.sha1 = found.sha1;
    }
    rewrites.push([id, JSON.stringify(slim)]);
  }

  totals.paired += paired;
  totals.dropped += dropped;
  totals.applied += rewrites.length;
  if (paired || dropped || rewrites.length)
    console.log(
      `${blogID}: ${paired} pairs from verified records, ${dropped} dropped, ${rewrites.length} applied records to slim`
    );

  if (!apply) return;

  // Pairs first: the verified records are deleted only once they're saved
  if (paired) await known.save({ complete: false });
  for (let i = 0; i < rewrites.length; i += 500) {
    const multi = client.multi();
    for (const [id, value] of rewrites.slice(i, i + 500))
      multi.hSet(appliedKey, id, value);
    await multi.exec();
  }
}

async function main() {
  const totals = { blogs: 0, paired: 0, dropped: 0, applied: 0 };

  for (const blogID of await database.blog.list()) {
    const account = await database.blog.get(blogID);
    if (!account || !account.folderId) continue;
    totals.blogs += 1;
    await backfillBlog(blogID, String(account.folderId), totals);
  }

  const leftovers = [];
  for (const pattern of [
    `${PREFIX}*:verified-content*`,
    `${PREFIX}*:metadata`,
  ]) {
    for (const key of await scan(pattern)) {
      const type = await client.type(key);
      if (type === "hash") leftovers.push(key);
      else if (type !== "none")
        console.log(`Skipping ${key}: type ${type}, expected hash`);
    }
  }

  let bytes = 0;
  for (const key of leftovers) bytes += (await client.memoryUsage(key)) || 0;

  console.log(
    `${totals.blogs} Drive blogs: ${totals.paired} pairs from verified records, ${totals.dropped} records dropped, ${totals.applied} applied records slimmed`
  );
  console.log(
    `${apply ? "Deleting" : "Would delete"} ${leftovers.length} verified-content and metadata keys (${(bytes / 1e6).toFixed(1)} MB)`
  );

  if (!apply) {
    console.log(
      "Dry run. Run again with --apply to write the pairs and delete the keys."
    );
    return;
  }

  for (let i = 0; i < leftovers.length; i += 100)
    await client.unlink(leftovers.slice(i, i + 100));
  console.log("Done.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
