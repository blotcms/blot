const fs = require("fs-extra");
const { join } = require("path");
const pipeline = require("util").promisify(require("stream").pipeline);
const tempDir = require("helper/tempDir")();
const guid = require("helper/guid");
const verifyContent = require("./verifyContent");

// Downloads changed files before the sync that applies them has the folder
// lock (#2847). The detection walk (sync/index.js, outside the lock) finds a
// file whose bytes Blot doesn't have and starts its download here; the apply
// under the lock then lists the directory again, and download.js takes the
// file from here, already downloaded and checked, instead of fetching it.
// So the download overlaps the rest of the detection walk (up to 3.4s on a
// 3,035-item folder) and the wait for the lock, rather than following them.
//
// Only files Drive gives an md5Checksum for, checked against it: an entry is
// keyed by file id and checksum, so it can only stand in for exactly the
// bytes the apply would have downloaded. In this process only (detection and
// apply run in the same one); an entry nobody takes is deleted after TTL_MS.
// Files over MAX_BYTES, and anything once MAX_ENTRIES or MAX_TOTAL_BYTES are
// held, are left to the apply, as before.
const TTL_MS = 2 * 60 * 1000;
const MAX_ENTRIES = 50;
const MAX_BYTES = 50 * 1024 * 1024;
const MAX_TOTAL_BYTES = 200 * 1024 * 1024;
const CONCURRENCY = 4;

const entries = new Map();
let held = 0;
let active = 0;
const waiting = [];

const keyOf = (id, md5Checksum) => `${id}:${md5Checksum}`;

const limited = async (fn) => {
  if (active >= CONCURRENCY)
    await new Promise((resolve) => waiting.push(resolve));
  active += 1;
  try {
    return await fn();
  } finally {
    active -= 1;
    if (waiting.length) waiting.shift()();
  }
};

const discard = (entry) =>
  entry.promise
    .then((result) => result && fs.remove(result.tempPath))
    .catch(() => {});

// Removes an entry from the map, and its size from what is held
const forget = (key, entry) => {
  entries.delete(key);
  clearTimeout(entry.timer);
  held -= entry.bytes;
};

// Starts downloading the file, unless it is already held or can't be
function start(drive, { id, md5Checksum, size }) {
  if (!drive || !id || !md5Checksum) return;
  const bytes = Number(size) || 0;
  if (bytes > MAX_BYTES) return;
  const key = keyOf(id, md5Checksum);
  if (entries.has(key) || entries.size >= MAX_ENTRIES) return;
  if (held + bytes > MAX_TOTAL_BYTES) return;

  const entry = { bytes };
  held += bytes;
  entry.promise = limited(async () => {
    const tempPath = join(tempDir, guid());
    try {
      const res = await drive.files.get(
        { fileId: id, alt: "media", supportsAllDrives: true },
        { responseType: "stream" }
      );
      await pipeline(res.data, fs.createWriteStream(tempPath));
      const hashes = await verifyContent(tempPath, md5Checksum);
      if (!hashes) throw new Error("Prefetched file does not match checksum");
      return { tempPath, hashes, downloadedAt: Date.now() };
    } catch (err) {
      await fs.remove(tempPath).catch(() => {});
      throw err;
    }
  });
  entry.promise.catch(() => {});
  entry.timer = setTimeout(() => {
    if (entries.get(key) !== entry) return;
    forget(key, entry);
    discard(entry);
  }, TTL_MS);
  entry.timer.unref?.();
  entries.set(key, entry);
}

// The downloaded file, { tempPath, hashes, downloadedAt }, now the caller's to move or
// remove, waiting for a download still running; or null when there is none
// or it failed, and the caller downloads it as before
async function take(id, md5Checksum) {
  if (!id || !md5Checksum) return null;
  const key = keyOf(id, md5Checksum);
  const entry = entries.get(key);
  if (!entry) return null;
  forget(key, entry);
  try {
    return await entry.promise;
  } catch (err) {
    return null;
  }
}

// Forgets and deletes everything held, for the specs
async function clear() {
  const all = [...entries];
  for (const [key, entry] of all) forget(key, entry);
  await Promise.all(all.map(([, entry]) => discard(entry)));
}

module.exports = { start, take, clear, MAX_BYTES, MAX_ENTRIES };
