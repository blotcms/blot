const fs = require("fs-extra");
const s3 = require("storage/s3");
const assets = require("storage/assets");
const { SCOPES } = require("./references");

const DAY = 24 * 60 * 60 * 1000;

// Directories deleted at once, and objects per delete request (S3's limit)
const CONCURRENCY = 4;
const DELETE_BATCH = 1000;

// A blog's generated files in the bucket, from one walk of its asset scope
// (assets.walkEntries), which both the sweep of generated directories and
// the Perma-Cache check need:
// - files: relPath -> last modified (ms), every file in the asset scope;
// - dirs: "<scope>/<id>" -> { files, bytes, newest, keys } for each
//   directory in SCOPES, where keys are the objects' exact keys in the
//   bucket. A bookmark screenshot is a single file directly in its scope
//   (_bookmark_screenshots/<hash>.png), so <id> can be a file name.
async function listing(blogID) {
  const files = new Map();
  const dirs = new Map();
  const prefix = blogID + "/";

  for await (const { relPath, modified, size } of assets.walkEntries(blogID)) {
    const time = new Date(modified).getTime() || 0;

    files.set(relPath, time);

    const segments = relPath.split("/");
    const scope = segments[0];
    const id = segments[1];

    if (!SCOPES.includes(scope) || !id) continue;

    const name = scope + "/" + id;

    if (!dirs.has(name))
      dirs.set(name, { files: 0, bytes: 0, newest: 0, keys: [] });

    const dir = dirs.get(name);

    dir.files++;
    dir.bytes += size || 0;
    dir.newest = Math.max(dir.newest, time);
    dir.keys.push(prefix + relPath);
  }

  return { files, dirs };
}

// Deletes the objects of each directory, by the exact keys the listing gave,
// never by a prefix: a directory (or a screenshot file) "abc" must not take
// "abcd" with it. storage/assets.remove would delete by prefix, so this uses
// the bucket's delete directly, and then removes whatever a tool left in the
// blog's staging directory for it (best effort). dirs is
// [{ name, keys }]. Rejects on the first
// failure, leaving the directories not yet deleted for the next run.
async function deleteDirs(blogID, dirs) {
  let next = 0;
  let failed = false;

  async function worker() {
    while (next < dirs.length && !failed) {
      const dir = dirs[next++];

      try {
        for (let i = 0; i < dir.keys.length; i += DELETE_BATCH)
          await s3.deleteKeys(dir.keys.slice(i, i + DELETE_BATCH));
      } catch (err) {
        failed = true;
        throw err;
      }

      await fs.remove(assets.path(blogID, dir.name)).catch(() => {});
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, dirs.length) }, worker)
  );
}

module.exports = { listing, deleteDirs, DAY };
