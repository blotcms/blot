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
//   node scripts/entry/repair-case-mismatched-paths.js --restore [file]
//
// With no blog IDs it checks every blog. --apply appends each entry, as it
// was, to a backup file ($BACKUP, or one in the temp directory) before
// moving it. --restore puts back any entry whose move didn't finish. A
// move keeps the entry's earlier URLs redirecting and its place on the
// menu.
const fs = require("fs");
const os = require("os");
const { basename, join } = require("path");
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

// Each entry, as it was, is appended here before it is moved
const BACKUP =
  process.env.BACKUP || join(os.tmpdir(), "repair-case-mismatched-paths.jsonl");

// The steps after the save, safe to repeat: earlier url keys still on the
// old ID point at the new one, and the menu item goes back to its place
async function finish(blogID, { oldID, to, urlKeys, menuItem, menuIndex }) {
  for (const key of urlKeys) {
    if ((await client.get(key)) === oldID) await client.set(key, to);
  }

  if (!menuItem) return;

  const menu = ((await Blog.get({ id: blogID })).menu || []).filter(
    (item) => item.id !== oldID && item.id !== to
  );

  menu.splice(
    Math.min(menuIndex, menu.length),
    0,
    Object.assign({}, menuItem, { id: to })
  );

  await Blog.set(blogID, { menu });
}

// For each backed-up move that didn't finish: puts the entry back if it
// was dropped and not saved again, or finishes the steps after the save
async function restore(file) {
  let restored = 0;
  let finished = 0;

  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;

    const move = JSON.parse(line);
    const { blogID, from, to, entry } = move;
    const now = await Entry.get(blogID, to);
    const old = await Entry.get(blogID, from);

    if (old && !old.deleted) continue;

    if (now && !now.deleted) {
      await finish(blogID, move);
      finished++;
      continue;
    }

    await Entry.set(blogID, from, entry);
    console.log(blogID, "RESTORED", from);
    restored++;
  }

  console.log(
    "Restored",
    restored,
    "entries and finished",
    finished,
    "moves from",
    file
  );
}

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

// Every url key of the blog which points at the entry: its current URL
// and any it had before, which routes/entry.js redirects from
async function urlKeysOf(blogID, entryID) {
  const keys = [];

  for await (const batch of client.scanIterator({
    MATCH: "blog:" + blogID + ":url:*",
    COUNT: 1000,
  })) {
    for (const key of Array.isArray(batch) ? batch : [batch]) {
      if ((await client.type(key)) !== "string") continue;
      if ((await client.get(key)) === entryID) keys.push(key);
    }
  }

  return keys;
}

async function move(blogID, entry, real) {
  const existing = await Entry.get(blogID, real);

  if (existing && !existing.deleted) {
    console.log(blogID, "SKIP", entry.path, "a live entry is at", real);
    return false;
  }

  const oldID = entry.id || entry.path;
  const moved = JSON.parse(JSON.stringify(entry));

  moved.id = real;
  moved.path = real;
  moved.name = basename(real);
  moved.deleted = false;

  const menu = (await Blog.get({ id: blogID })).menu || [];
  const menuIndex = menu.findIndex((item) => item.id === oldID);
  const move = {
    blogID,
    from: entry.path,
    to: real,
    oldID,
    urlKeys: await urlKeysOf(blogID, oldID),
    menuItem: menuIndex > -1 ? menu[menuIndex] : null,
    menuIndex,
    entry,
  };

  // Kept before the drop, so --restore can put the entry back or finish
  // the move if this process dies part way
  fs.appendFileSync(BACKUP, JSON.stringify(move) + "\n");

  await Entry.drop(blogID, oldID);

  try {
    await Entry.set(blogID, real, moved);
  } catch (err) {
    await Entry.set(blogID, entry.path, entry);
    throw new Error("saving " + real + " failed, restored: " + err.message, {
      cause: err,
    });
  }

  // Earlier URLs keep redirecting to the entry, and the drop took a page
  // off the menu and the save appended it: put it back where it was
  await finish(blogID, move);

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

  if (args[0] === "--restore") return restore(args[1] || BACKUP);

  const apply = args.includes("--apply");

  if (apply) console.log("Backing up each entry before its move to", BACKUP);
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
