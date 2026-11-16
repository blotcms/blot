// Moves entries whose stored path differs only in case from their file in
// the folder onto the file's real path, keeping their URL, dates and guid.
//
// Fix()'s entry-ghosts check (app/sync/fix/entry-ghosts.js) only tries
// lowercasing parts of an entry's path, so an entry stored as
// "/posts/a.md" over the file "/Posts/a.md" is dropped as a ghost although
// its file is there. Old entries were often stored with lowercased paths.
//
// A rebuild is no repair: the old entry is still live and holds the URL, so
// the rebuilt one would get a "-2" URL before Fix() dropped the old one.
// Instead each entry is dropped first (a deleted entry frees its URL) and
// saved again at the real path with its own fields.
//
// Read-only unless --apply is passed. Re-running is safe: an entry already
// moved no longer matches. Each blog is repaired holding its sync lock.
//
//   node scripts/entry/repair-case-mismatched-paths.js [--apply] [blogID ...]
//
// With no blog IDs it checks every blog.
const { basename } = require("path");
const client = require("models/client");
const Blog = require("models/blog");
const Entry = require("models/entry");
const storage = require("storage/folder");
const Sync = require("sync");
const flushCache = require("helper/flushProxies");
const config = require("config");
const BackupDomain = require("models/blog/util/backupDomain");
const folderPostFolder = require("sync/update/folderPostSourceFolder");

const LIVE_LISTS = ["entries", "drafts", "pages", "scheduled"];

// The paths entry-ghosts tries, in its order (resolvePath)
function candidates(path) {
  const out = [path, path.trim()];

  if (path.toLowerCase() !== path) {
    const dirs = path.split("/");

    for (let i = dirs.length - 1; i >= 0; i--) {
      dirs[i] = dirs[i].toLowerCase();
      out.push(dirs.join("/"));
      out.push(dirs.join("/").trim());
    }
  }

  return out;
}

// The real path of an entry's file, when entry-ghosts would miss it
async function unrepairable(blogID, path) {
  for (const candidate of candidates(path)) {
    if (await storage.exists(blogID, candidate)) return null;
  }

  let real;

  try {
    real = await storage.resolveCaseInsensitive(blogID, path);
  } catch (err) {
    if (err.name === "NotFoundError") return null;
    throw err;
  }

  return real !== path ? real : null;
}

// [{ entry, real }] for each live entry entry-ghosts would drop
async function mismatched(blogID) {
  const ids = new Set();

  for (const list of LIVE_LISTS) {
    for (const id of await client.zRange("blog:" + blogID + ":" + list, 0, -1))
      ids.add(id);
  }

  const found = [];

  for (const id of ids) {
    if (!id || id[0] !== "/") continue;

    const real = await unrepairable(blogID, id);
    if (!real) continue;

    const entry = await Entry.get(blogID, id);
    if (!entry || entry.deleted || folderPostFolder(entry)) continue;

    found.push({ entry, real });
  }

  return found;
}

async function move(blogID, entry, real) {
  const existing = await Entry.get(blogID, real);

  if (existing && !existing.deleted) {
    console.log(blogID, "SKIP", entry.path, "a live entry is at", real);
    return false;
  }

  const moved = JSON.parse(JSON.stringify(entry));

  moved.id = real;
  moved.path = real;
  moved.name = basename(real);
  moved.deleted = false;

  await Entry.drop(blogID, entry.id || entry.path);
  await Entry.set(blogID, real, moved);

  const saved = await Entry.get(blogID, real);
  const same = saved && saved.url === entry.url;

  console.log(
    blogID,
    same ? "MOVED" : "MOVED, URL CHANGED",
    entry.path,
    "->",
    real,
    same ? entry.url : entry.url + " -> " + (saved && saved.url)
  );

  return true;
}

async function flush(blogID) {
  const blog = await Blog.get({ id: blogID });
  const hosts = [];

  if (blog.domain) hosts.push(blog.domain, BackupDomain(blog.domain));
  if (blog.handle) hosts.push(blog.handle + "." + config.host);

  await Blog.set(blogID, { cacheID: Date.now() });
  if (hosts.length) await flushCache(hosts);
}

async function repair(blogID, apply) {
  const found = await mismatched(blogID);

  if (!found.length) return 0;

  if (!apply) {
    for (const { entry, real } of found)
      console.log(blogID, "WOULD MOVE", entry.path, "->", real, entry.url);
    return found.length;
  }

  let moved = 0;

  await Sync(blogID, async function () {
    // Checked again under the lock: a sync may have changed things
    for (const { entry, real } of await mismatched(blogID)) {
      if (await move(blogID, entry, real)) moved++;
    }
  });

  if (moved) await flush(blogID);

  return moved;
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  let blogIDs = args.filter((arg) => arg !== "--apply");

  if (!blogIDs.length) blogIDs = (await Blog.getAllIDs()).sort();

  let blogs = 0;
  let entries = 0;
  let failed = 0;

  for (const blogID of blogIDs) {
    try {
      const count = await repair(blogID, apply);
      if (count) blogs++;
      entries += count;
    } catch (err) {
      failed++;
      console.error(blogID, "FAILED", err.message);
    }
  }

  console.log(
    apply ? "Moved" : "Would move",
    entries,
    "entries in",
    blogs,
    "blogs;",
    failed,
    "blogs failed",
    apply ? "" : "(pass --apply to move them)"
  );

  if (failed) process.exitCode = 1;
}

if (require.main === module) {
  main()
    .then(() => process.exit())
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
