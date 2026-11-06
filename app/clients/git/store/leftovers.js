// Clearing out what a killed process left behind in the scratch directory.
//
// An import, a verify or a rewrite builds its output in a directory of its own
// (import-XXXXXX, verify-XXXXXX, rewrite-XXXXXX, as `fs.mkdtemp` names them)
// and removes it when it ends, in a `finally`. A process which is killed in
// the middle (a deploy replacing the container) never gets there, and the
// directory stays: several GB for a large repository.
//
// The scratch directory is shared by processes which cannot see each other
// (several containers, a script run by hand), so a leftover is told from a
// directory in use by age alone. A directory is removed only when the newest
// modification time of the directory itself and of everything directly inside
// it is older than `minAge`. A live operation keeps writing into its
// directory, which moves those times; `minAge` is far longer than the longest
// pause an operation is known to make, so it is not mistaken for dead.
//
// Only directories (not links) whose names are one of the prefixes followed by
// the six characters `mkdtemp` adds are touched, and only directly inside
// `dir`. Nothing here throws on a directory which vanishes underneath it.
const fsp = require("fs/promises");
const path = require("path");

// setup- is the served path's new-folder setup (app/clients/git/served/create.js)
const PREFIXES = ["import-", "verify-", "rewrite-", "setup-"];

// An import of a 5 GB repository takes about 20 minutes; this is many times
// that, so only a directory whose owner is certainly gone is removed. A
// leftover waits at most this long (and a day for the next run) before it goes.
const MIN_AGE_MS = 12 * 60 * 60 * 1000;

const NAME = new RegExp(
  "^(" +
    PREFIXES.map((p) => p.replace("-", "\\-")).join("|") +
    ")[A-Za-z0-9]{6}$"
);

// The newest mtime of dir and its immediate contents, and the bytes in all of
// it. Null if dir is gone. Entries which vanish while it looks are skipped.
async function inspect(dir) {
  let newest;
  try {
    newest = (await fsp.lstat(dir)).mtimeMs;
  } catch (err) {
    return null;
  }

  let bytes = 0;
  const walk = async (current, top) => {
    let names;
    try {
      names = await fsp.readdir(current, { withFileTypes: true });
    } catch (err) {
      return;
    }
    for (const entry of names) {
      const full = path.join(current, entry.name);
      let stat;
      try {
        stat = await fsp.lstat(full);
      } catch (err) {
        continue;
      }
      if (top && stat.mtimeMs > newest) newest = stat.mtimeMs;
      if (stat.isDirectory()) await walk(full, false);
      else bytes += stat.size;
    }
  };
  await walk(dir, true);

  return { newest, bytes };
}

// sweepScratch({ dir, minAge?, now?, prefixes? }) resolves
// { removed, spared, bytes, errors }: the leftovers removed, the matching
// directories kept for being too recent, the bytes removed, and the removals
// which failed. It rejects only if dir cannot be listed for a reason other
// than not existing.
async function sweepScratch({
  dir,
  minAge = MIN_AGE_MS,
  now = Date.now(),
  prefixes = PREFIXES,
} = {}) {
  const result = { removed: 0, spared: 0, bytes: 0, errors: 0 };
  const matches = (name) =>
    NAME.test(name) && prefixes.some((p) => name.startsWith(p));

  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT" || err.code === "ENOTDIR") return result;
    throw err;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || !matches(entry.name)) continue;

    const full = path.join(dir, entry.name);
    const seen = await inspect(full);

    if (!seen) continue;

    if (now - seen.newest < minAge) {
      result.spared++;
      continue;
    }

    try {
      await fsp.rm(full, { recursive: true, force: true });
      result.removed++;
      result.bytes += seen.bytes;
    } catch (err) {
      if (err.code !== "ENOENT") result.errors++;
    }
  }

  return result;
}

module.exports = { sweepScratch, PREFIXES, MIN_AGE_MS };
