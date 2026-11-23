const fs = require("fs-extra");
const { join } = require("path");
const archiver = require("archiver");
const s3 = require("storage/s3");
const tempDir = require("helper/tempDir");
const { listFiles, hashFolder } = require("./contents");

// The download ZIPs of the demo folders live in the storage bucket, under
// folders/<name>-<hash>.zip, where <hash> is contents.hashFolder() of the
// folder. That prefix isn't public: app/cdn serves /folders/<name>-<hash>.zip
// from it, and Bunny keeps the copy (Perma-Cache). A key is never written
// twice with different bytes, so the CDN can cache it for a year.

const PREFIX = "folders/";
const KEY = /^([a-z0-9][a-z0-9_-]*)-([a-f0-9]{16})\.zip$/;

function keyFor(name, hash) {
  return PREFIX + name + "-" + hash + ".zip";
}

// Writes the ZIP of directory to path. Its entries are the folder's files at
// the ZIP's root, as when people unzip it into an empty folder. JPEGs make up
// most of the demo folders and barely compress, so a low level is as small
// as a high one and much faster.
function writeZip(directory, files, path) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(path);
    const archive = archiver("zip", { zlib: { level: 1 } });

    output.on("close", resolve);
    output.on("error", reject);
    archive.on("warning", reject);
    archive.on("error", reject);

    archive.pipe(output);
    for (const file of files)
      archive.file(join(directory, file), { name: file });
    archive.finalize();
  });
}

// Uploads the ZIP of the folder at directory unless the bucket has it, then
// deletes the folder's other ZIPs except the newest of them. That one is the
// previous version: the deploy step can upload before the units go out,
// while the old image still links it, and a deploy can roll back to it. The
// weekly Perma-Cache sweep (storage/sweep/permaCache) drops the CDN's copies
// of the hashes no longer linked. Resolves to { key, uploaded, removed }.
async function publishZip(name, directory) {
  const hash = await hashFolder(directory);
  const key = keyFor(name, hash);
  let uploaded = false;

  if (!(await s3.head(key))) {
    const files = await listFiles(directory);
    const path = join(tempDir(), "folder-zip-" + name + "-" + hash + ".zip");

    try {
      await writeZip(directory, files, path);
      await s3.uploadFile(key, path, { contentType: "application/zip" });
      uploaded = true;
    } finally {
      await fs.remove(path);
    }
  }

  const others = [];
  for await (const entry of s3.listEntries(PREFIX + name + "-")) {
    const match = entry.key && KEY.exec(entry.key.slice(PREFIX.length));
    if (match && match[1] === name && entry.key !== key) others.push(entry);
  }
  others.sort((a, b) => new Date(b.modified) - new Date(a.modified));
  const old = others.slice(1).map((entry) => entry.key);
  if (old.length) await s3.deleteKeys(old);

  return { key, uploaded, removed: old };
}

module.exports = publishZip;
module.exports.PREFIX = PREFIX;
module.exports.KEY = KEY;
module.exports.keyFor = keyFor;
