// Moves one path, or a whole tree, from the source directory into the blog's
// folder, through storage/folder. Used by the watcher (one path at a time) and
// by setup (every path). The source wins: whatever differs in the folder is
// overwritten or removed.

const fs = require("fs-extra");
const crypto = require("crypto");
const { dirname } = require("path");
const folder = require("storage/folder");
const shouldIgnoreFile = require("clients/util/shouldIgnoreFile");
const { absolute } = require("./source");

// storage/folder stores names in NFC, so names are compared that way. A
// source name is still read from disk with its own spelling.
const nfc = (path) => path.normalize("NFC");

function sha1(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha1");
    fs.createReadStream(file)
      .on("error", reject)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve(hash.digest("hex")));
  });
}

async function folderStat(blogID, path, options) {
  try {
    return await folder.stat(blogID, path, options);
  } catch (err) {
    if (err instanceof folder.NotFoundError || err.code === "ENOENT")
      return null;
    throw err;
  }
}

async function sourceStat(dir, path) {
  try {
    const stat = await fs.lstat(absolute(dir, path));
    if (stat.isDirectory()) return { isDirectory: true, stat };
    if (stat.isFile()) return { isDirectory: false, stat };
    return null; // a symlink or something else: not synced
  } catch (err) {
    if (err.code === "ENOENT" || err.code === "ENOTDIR") return null;
    throw err;
  }
}

// Removes path from the folder. For a directory, the paths of everything in it
// are pushed to removed first, for the caller to pass to folder.update as well
// so their entries are dropped.
async function removeFromFolder(blogID, path, current, removed) {
  if (removed && current && current.isDirectory) {
    for await (const child of folder.walk(blogID, path, {
      directories: true,
    })) {
      removed.push(child);
    }
  }
  await folder.remove(blogID, path);
}

// Makes the folder's path match the source's. Resolves true if it changed.
// Paths removed along with a directory are pushed to removed.
async function syncPath(blogID, dir, path, removed) {
  const source = await sourceStat(dir, path);
  const current = await folderStat(
    blogID,
    path,
    source && !source.isDirectory ? { sha1: true } : undefined
  );

  if (!source) {
    if (!current) return false;
    await removeFromFolder(blogID, path, current, removed);
    return true;
  }

  if (source.isDirectory) {
    if (current && current.isDirectory) return false;
    if (current) await removeFromFolder(blogID, path, current, removed);
    await folder.mkdir(blogID, path);
    return true;
  }

  const file = absolute(dir, path);

  if (
    current &&
    !current.isDirectory &&
    current.size === source.stat.size &&
    current.sha1 === (await sha1(file))
  ) {
    return false;
  }

  if (current && current.isDirectory)
    await removeFromFolder(blogID, path, current, removed);
  await folder.writeFrom(blogID, path, file, { modified: source.stat.mtimeMs });
  return true;
}

// Every path in the source directory, "/a", "/a/b.txt", parents first
async function listSource(dir, path = "/", found = []) {
  const entries = await fs.readdir(absolute(dir, path), {
    withFileTypes: true,
  });
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  for (const entry of entries) {
    const child = (path === "/" ? "" : path) + "/" + entry.name;
    if (shouldIgnoreFile(entry.name)) continue;
    if (entry.isDirectory()) {
      found.push(child);
      await listSource(dir, child, found);
    } else if (entry.isFile()) {
      found.push(child);
    }
  }

  return found;
}

// Makes the whole folder match the source: copies what is missing or differs
// (size, then SHA-1) and removes extras. The paths which changed, including
// those removed with a directory, are pushed to changed as it goes, so a
// caller whose reconcile fails part way still knows what to update.
async function reconcile(blogID, dir, changed = []) {
  const wanted = await listSource(dir);
  const present = new Set(wanted.map(nfc));

  async function apply(path) {
    const removed = [];
    try {
      if (await syncPath(blogID, dir, path, removed)) changed.push(path);
    } finally {
      changed.push(...removed);
    }
  }

  for (const path of wanted) await apply(path);

  const extras = [];
  for await (const path of folder.walk(blogID, "/", { directories: true })) {
    if (!present.has(nfc(path)) && !path.split("/").some(shouldIgnoreFile))
      extras.push(path);
  }

  // Deepest first, so a directory goes after what is in it
  extras.sort((a, b) => b.length - a.length);
  for (const path of extras) await apply(path);

  return changed;
}

// Copies the blog's folder into a new source directory, for a blog whose
// folder used to be watched directly. The copy is made in a temporary
// directory beside dir and renamed into place once all of it is there, so a
// failure never leaves a partial directory which later looks authoritative.
// Resolves the number of files copied.
async function seed(blogID, dir) {
  const staging = dir + ".seeding";
  await fs.remove(staging);
  await fs.ensureDir(staging);
  let count = 0;

  try {
    for await (const path of folder.walk(blogID, "/", { directories: true })) {
      if (path.split("/").some(shouldIgnoreFile)) continue;
      const target = absolute(staging, path);
      const stat = await folderStat(blogID, path);
      if (!stat) continue;

      if (stat.isDirectory) {
        await fs.ensureDir(target);
        continue;
      }

      await fs.ensureDir(dirname(target));
      await fs.writeFile(target, await folder.read(blogID, path));
      if (stat.modified)
        await fs.utimes(target, new Date(), new Date(stat.modified));
      count++;
    }

    await fs.rename(staging, dir);
  } catch (err) {
    await fs.remove(staging).catch(function () {});
    throw err;
  }

  return count;
}

module.exports = { syncPath, reconcile, seed, listSource };
