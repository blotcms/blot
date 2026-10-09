// Nothing else cleans up config.tmp_directory (the app's scratch space on the
// instance store, shared by every container): uploads, conversions and the
// like are meant to remove their own files, but a crash or a deploy mid-job
// leaves them behind. This removes what is old enough that nothing can still
// be using it. It is run daily by the scheduler (app/scheduler/index.js).
const fs = require("fs-extra");
const config = require("config");
const path = require("path");
const lifecycle = require("../dashboard/site/import/lifecycle");

// Nothing the app puts in tmp is meant to last this long: uploads are
// consumed by the request that made them, and conversions by the build.
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

// Imports (tmp/import/<blogID>/<importID>) are the exception: the result.zip
// is for the customer to download from the dashboard after the import
// finishes, and they may not look until later. Nothing in the app or the
// dashboard promises how long it stays, so this is a week - long enough to
// come back to, short enough that abandoned archives (which can be large)
// don't pile up on the instance store.
const IMPORT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const IMPORT_DIRECTORY = "import";

// Total size of the files under a path, without following symlinks
async function sizeOf(entryPath) {
  const stat = await fs.lstat(entryPath);

  if (!stat.isDirectory()) return stat.size;

  let total = 0;

  for (const name of await fs.readdir(entryPath)) {
    total += await sizeOf(path.join(entryPath, name)).catch(() => 0);
  }

  return total;
}

async function readdir(directory) {
  try {
    return await fs.readdir(directory);
  } catch (err) {
    // nothing there yet
    if (err.code === "ENOENT" || err.code === "ENOTDIR") return [];
    throw err;
  }
}

// Removes the entries directly inside `directory` that were last modified more
// than maxAgeMs ago, except those for which skip(entryPath) is true.
async function prune(directory, maxAgeMs, now, report, skip) {
  for (const name of await readdir(directory)) {
    const entryPath = path.join(directory, name);

    try {
      const stat = await fs.lstat(entryPath);

      if (now - stat.mtimeMs <= maxAgeMs) continue;
      if (skip && skip(entryPath)) continue;

      const bytes = await sizeOf(entryPath).catch(() => 0);

      await fs.remove(entryPath);

      report.removed++;
      report.bytes += bytes;
    } catch (err) {
      report.errors++;
      console.error("Tmp: could not remove " + entryPath, err);
    }
  }
}

// options: tmpDirectory, now, maxAgeMs, importMaxAgeMs
// (default to the real ones)
module.exports = async function pruneTmp(options) {
  options = options || {};

  const tmpDirectory = options.tmpDirectory || config.tmp_directory;
  const now = options.now === undefined ? Date.now() : options.now;
  const maxAgeMs = options.maxAgeMs === undefined ? MAX_AGE_MS : options.maxAgeMs;
  const importMaxAgeMs =
    options.importMaxAgeMs === undefined ? IMPORT_MAX_AGE_MS : options.importMaxAgeMs;
  const report = { removed: 0, bytes: 0, errors: 0 };

  // Everything in tmp except imports, which are one level further down and
  // have their own lifetime. The import directory's own mtime says nothing
  // about its contents, so it is never judged on its age.
  const importRoot = path.join(tmpDirectory, IMPORT_DIRECTORY);

  await prune(tmpDirectory, maxAgeMs, now, report, (entryPath) => entryPath === importRoot);

  for (const blogID of await readdir(importRoot)) {
    // An import with a live lease (running.txt) has a worker on it. Imports
    // whose worker died leave an expired lease behind, which only ages out.
    await prune(path.join(importRoot, blogID), importMaxAgeMs, now, report, (importPath) => {
      const expiresAt = lifecycle.leaseExpiry(importPath);
      return expiresAt !== undefined && expiresAt > now;
    });
  }

  return report;
};

module.exports.MAX_AGE_MS = MAX_AGE_MS;
module.exports.IMPORT_MAX_AGE_MS = IMPORT_MAX_AGE_MS;
