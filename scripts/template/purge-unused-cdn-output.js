// docker exec -it blot-container-green node scripts/template/purge-unused-cdn-output.js [--apply]
//
// Prepares rendered {{#cdn}} output to be served from Redis alone, off the old
// disk store (data/cdn/template). Run it while the app still writes both
// stores, i.e. before deploying the Redis-only route:
//
// 1. Collects every hash in use from the cdn field of each template:*:info hash
// 2. Backfills Redis from disk for hashes in use whose cdn:rendered:<hash> key
//    is missing (scripts/db/migrate-rendered-output-to-disk.js deleted them)
// 3. Deletes unused output: unused files' keys, plus unused keys with no file
// 4. Rescans the manifests and restores anything deleted that a save made
//    current again in the meantime
// 5. Writes the unused files' URLs to a list, then purges them from Bunny.
//    Keys with no file have no file name, so no URL; nothing links to them.
//
// A hash only counts as unused if it is missing from the manifests both before
// and after the scan, and its file is over an hour old: a save writes the file
// and key before it publishes the manifest, so a fresh file may be about to go
// live. (A key with no file predates disk storage; the app writes both.)
// Dry run by default; pass --apply to write and delete.
// Once the Redis-only route is deployed: rm -rf <data_directory>/cdn/template

const fs = require("fs-extra");
const path = require("path");
const config = require("config");
const client = require("models/client");
const key = require("models/template/key");
const generateCdnUrl = require("models/template/util/generateCdnUrl");
const purgeCdnUrls = require("helper/purgeCdnUrls");
const redisKeys = require("../util/redisKeys");

const APPLY = process.argv.includes("--apply");
const DISK_DIR = path.join(config.data_directory, "cdn", "template");
const URL_LIST = path.join(config.data_directory, "cdn-template-purge-urls.txt");
const HASH = /^[a-f0-9]{32}$/;
const MIN_AGE = 60 * 60 * 1000;

async function hashesInUse() {
  const hashes = new Set();

  // A failed read throws: a missed manifest would make live output look unused
  await redisKeys("template:*:info", async (metadataKey) => {
    const json = await client.hGet(metadataKey, "cdn");
    if (!json) return;

    let manifest;
    try {
      manifest = JSON.parse(json);
    } catch (err) {
      throw new Error(`Invalid cdn manifest in ${metadataKey}: ${err.message}`);
    }

    for (const target in manifest) {
      if (typeof manifest[target] === "string") hashes.add(manifest[target]);
    }
  });

  return hashes;
}

// Files are stored at <DISK_DIR>/<hash[0:2]>/<hash[2:4]>/<hash[4:]>/<basename>
async function filesOnDisk() {
  const files = [];

  if (!(await fs.pathExists(DISK_DIR))) return files;

  for (const dir1 of await fs.readdir(DISK_DIR)) {
    for (const dir2 of await readdirSafe(path.join(DISK_DIR, dir1))) {
      for (const rest of await readdirSafe(path.join(DISK_DIR, dir1, dir2))) {
        const hash = dir1 + dir2 + rest;
        if (!HASH.test(hash)) continue;

        const dir = path.join(DISK_DIR, dir1, dir2, rest);
        for (const name of await readdirSafe(dir)) {
          const filePath = path.join(dir, name);
          const { size, mtimeMs } = await fs.stat(filePath);
          files.push({ hash, name, size, mtimeMs, path: filePath });
        }
      }
    }
  }

  return files;
}

async function readdirSafe(dir) {
  try {
    return await fs.readdir(dir);
  } catch (err) {
    if (err.code === "ENOTDIR" || err.code === "ENOENT") return [];
    throw err;
  }
}

async function main() {
  console.log(APPLY ? "Applying" : "Dry run (pass --apply to write and delete)");

  const before = await hashesInUse();
  console.log(`Hashes in use: ${before.size}`);

  const files = await filesOnDisk();
  const keys = new Set();
  await redisKeys("cdn:rendered:*", async (redisKey) => {
    keys.add(redisKey.slice("cdn:rendered:".length));
  });
  console.log(`Files on disk: ${files.length}, cdn:rendered keys: ${keys.size}`);

  const after = await hashesInUse();
  const inUse = (hash) => before.has(hash) || after.has(hash);

  const fileHashes = new Set(files.map((file) => file.hash));
  const backfill = files.filter((file) => after.has(file.hash) && !keys.has(file.hash));
  const missing = Array.from(after).filter((hash) => !keys.has(hash) && !fileHashes.has(hash));

  const recent = new Set(
    files.filter((file) => Date.now() - file.mtimeMs < MIN_AGE).map((file) => file.hash)
  );
  const unusedFiles = files.filter((file) => !inUse(file.hash) && !recent.has(file.hash));
  const unusedKeys = Array.from(keys).filter((hash) => !inUse(hash) && !fileHashes.has(hash));

  const urls = unusedFiles.map((file) => generateCdnUrl(file.name, file.hash));
  const bytes = unusedFiles.reduce((total, file) => total + file.size, 0);

  console.log(`Hashes in use to backfill from disk: ${backfill.length}`);
  console.log(`Hashes in use with neither a key nor a file: ${missing.length}`);
  missing.slice(0, 10).forEach((hash) => console.log(`  ${hash}`));
  console.log(
    `Unused files: ${unusedFiles.length} (${(bytes / 1024 / 1024).toFixed(1)}MB), ` +
      `URLs to purge: ${urls.length}`
  );
  console.log(`Unused keys with no file: ${unusedKeys.length}`);

  if (!APPLY) return;

  for (const file of backfill) {
    await client.set(key.renderedOutput(file.hash), await fs.readFile(file.path, "utf8"), {
      NX: true,
    });
  }
  console.log(`Backfilled ${backfill.length} keys from disk`);

  // Keep what is deleted, in case a save makes it current again meanwhile
  const deleted = new Map();
  for (const file of unusedFiles) {
    if (keys.has(file.hash)) deleted.set(file.hash, () => fs.readFile(file.path, "utf8"));
  }
  for (const hash of unusedKeys) {
    const content = await client.get(key.renderedOutput(hash));
    if (content != null) deleted.set(hash, () => content);
  }

  const hashes = Array.from(deleted.keys());
  for (let i = 0; i < hashes.length; i += 500) {
    await client.del(hashes.slice(i, i + 500).map((hash) => key.renderedOutput(hash)));
  }
  console.log(`Deleted ${hashes.length} cdn:rendered keys`);

  const now = await hashesInUse();
  let restored = 0;
  const failed = [];
  for (const [hash, read] of deleted) {
    if (!now.has(hash)) continue;
    try {
      await client.set(key.renderedOutput(hash), await read(), { NX: true });
      restored++;
    } catch (err) {
      console.error(`Could not restore ${hash}:`, err);
      failed.push(hash);
    }
  }
  if (restored) console.log(`Restored ${restored} keys a save made current again`);

  // Rerunning backfills them from disk, which is still in place
  if (failed.length) {
    throw new Error(`Could not restore ${failed.length} live keys, rerun the script: ${failed.join(" ")}`);
  }

  // purgeCdnUrls logs failures without throwing: keep the list to retry from
  await fs.writeFile(URL_LIST, urls.join("\n") + "\n");
  console.log(`Wrote ${urls.length} URLs to ${URL_LIST}; purging from Bunny...`);
  await purgeCdnUrls(urls);
  console.log(`Done. Check the log for failed purges, then remove ${DISK_DIR}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
