// Finds, and with `apply` removes, the live clones left in git blogs' folders:
// a .git directory which older blogs have, made by Blot's git client before
// its commits moved to the bare repository (#2259 PR 8) and, since #2459, to
// the git store. Nothing reads them now. scripts/git/remove-live-clones.js is
// the command line.
//
// A blog's .git is removed only when all of these hold, so nothing a user put
// there, and nothing the store lacks, is lost:
//
//   - the blog is on the git client;
//   - its folder has a .git (storage/folder, so whichever backend it is on);
//   - that .git's origin is the blog's own bare repository on Blot's disk:
//     a path ending in git/<handle>.git, as the live-clone code set it;
//   - the commit its HEAD names is in the store and reachable from master
//     there, so the clone holds nothing the store has not got.
//
// Anything else is kept, with its reason:
//
//   not-git        the blog is not on the git client
//   no-clone       its folder has no .git
//   other-origin   the .git's origin is not the blog's bare repository (or it
//                  has none): someone else's checkout
//   ahead          its HEAD is not in the store, or not reachable from master
//   no-store       the store has no copy of the blog's repository
//   unreadable     the .git's config, HEAD or ref, or the store, could not be
//                  read: the clone's HEAD commit too, when the store names it
//                  but cannot read it
//
// The .git is read through storage/folder alone: config, HEAD, the ref HEAD
// names (loose, or in packed-refs).
const storage = require("storage/folder");
const Blog = require("models/blog");
const manifest = require("./store/manifest");
const createReader = require("./store/reader");
const { parseCommit } = require("./store/objects");
const context = require("./served/context");

const MASTER = "refs/heads/master";

// How many commits back from master the search for the clone's HEAD goes
const MAX_WALK = 100000;

function getBlog(id) {
  return new Promise((resolve, reject) => Blog.get({ id }, (err, blog) => (err ? reject(err) : resolve(blog || null))));
}

function allBlogIDs() {
  return new Promise((resolve, reject) => Blog.getAllIDs((err, ids) => (err ? reject(err) : resolve(ids || []))));
}

async function readText(blogID, path) {
  try {
    return (await storage.read(blogID, path)).toString("utf8");
  } catch (err) {
    if (err.code === "ENOENT" || err.code === "ENOTDIR") return null;
    throw err;
  }
}

// The url of [remote "origin"] in a git config, or null
function originOf(config) {
  let inOrigin = false;

  for (const raw of config.split("\n")) {
    const line = raw.trim();
    if (/^\[/.test(line)) {
      inOrigin = /^\[remote\s+"origin"\]$/.test(line);
      continue;
    }
    if (!inOrigin) continue;
    const match = /^url\s*=\s*(.+)$/.exec(line);
    if (match) return match[1].trim();
  }

  return null;
}

// Whether a url is the blog's bare repository as the live-clone code set it:
// <data directory>/git/<handle>.git, on local disk
function isOwnBareRepo(url, handle) {
  if (!url || !handle || /^[a-z][a-z0-9+.-]*:/i.test(url)) return false;
  const parts = url.replace(/\/+$/, "").split("/");
  return parts.length >= 2 && parts[parts.length - 1] === handle + ".git" && parts[parts.length - 2] === "git";
}

// The commit HEAD names, or null if it can't be read
async function headOf(blogID) {
  const head = await readText(blogID, "/.git/HEAD");
  if (!head) return null;

  const text = head.trim();
  if (/^[0-9a-f]{40}$/.test(text)) return text;

  const match = /^ref:\s*(refs\/\S+)$/.exec(text);
  if (!match) return null;

  const loose = await readText(blogID, "/.git/" + match[1]);
  if (loose && /^[0-9a-f]{40}$/.test(loose.trim())) return loose.trim();

  const packed = await readText(blogID, "/.git/packed-refs");
  if (!packed) return null;

  for (const line of packed.split("\n")) {
    const [oid, ref] = line.trim().split(" ");
    if (ref === match[1] && /^[0-9a-f]{40}$/.test(oid)) return oid;
  }

  return null;
}

// Whether the commit is master in the store or one of its ancestors: true
// only once the commit itself has been read from the store, "unreadable" if
// master or a parent names it but it can't be read, false if it isn't there
async function reachable(blogID, oid) {
  const store = context.storeFor(blogID);
  const cache = context.cache();
  const current = await manifest.read(store);

  if (manifest.isEmpty(current)) return "no-store";

  const master = current.refs[MASTER];
  if (!master) return false;

  const reader = createReader({ store, cache, manifest: current, scratch: cache });
  const seen = new Set();
  const queue = [master];

  while (queue.length && seen.size < MAX_WALK) {
    const next = queue.shift();
    if (seen.has(next)) continue;
    seen.add(next);

    let object;
    try {
      object = await reader.read(next);
    } catch (err) {
      // The clone's own commit must be readable from the store, or the clone
      // may hold what the store has lost
      if (next === oid) return "unreadable";
      if (err.code === "NOT_FOUND") continue;
      throw err;
    }

    if (next === oid) return !!object && object.type === "commit" ? true : "unreadable";
    if (!object || object.type !== "commit") continue;

    queue.push(...parseCommit(object.data).parents);
  }

  return false;
}

// { blog, outcome: "removable" | "removed" | "kept" | "failed", reason?, detail? }
async function check(blogID, { apply = false } = {}) {
  let blog;

  try {
    blog = await getBlog(blogID);
  } catch (err) {
    return { blog: blogID, outcome: "kept", reason: "unreadable", detail: err.message };
  }

  if (!blog || blog.client !== "git") return { blog: blogID, outcome: "kept", reason: "not-git" };

  try {
    let found;
    try {
      found = await storage.stat(blogID, "/.git");
    } catch (err) {
      if (err.code !== "ENOENT" && err.code !== "ENOTDIR") throw err;
    }
    if (!found) return { blog: blogID, outcome: "kept", reason: "no-clone" };

    const config = await readText(blogID, "/.git/config");
    if (config === null) return { blog: blogID, outcome: "kept", reason: "unreadable", detail: "no .git/config" };

    if (!isOwnBareRepo(originOf(config), blog.handle)) return { blog: blogID, outcome: "kept", reason: "other-origin" };

    const head = await headOf(blogID);
    if (!head) return { blog: blogID, outcome: "kept", reason: "unreadable", detail: "no HEAD commit" };

    const onMaster = await reachable(blogID, head);
    if (onMaster === "no-store") return { blog: blogID, outcome: "kept", reason: "no-store" };
    if (onMaster === "unreadable") return { blog: blogID, outcome: "kept", reason: "unreadable", detail: "the store cannot read the clone's HEAD commit" };
    if (!onMaster) return { blog: blogID, outcome: "kept", reason: "ahead" };
  } catch (err) {
    return { blog: blogID, outcome: "kept", reason: "unreadable", detail: err.message };
  }

  if (!apply) return { blog: blogID, outcome: "removable" };

  try {
    await storage.remove(blogID, "/.git");
    return { blog: blogID, outcome: "removed" };
  } catch (err) {
    return { blog: blogID, outcome: "failed", detail: err.message };
  }
}

// Checks every blog (or `ids`), one at a time. Calls onResult for each.
// Resolves with the counts by outcome and reason.
async function run({ apply = false, ids = null, onResult = () => {} } = {}) {
  const counts = { blogs: 0, removable: 0, removed: 0, failed: 0, kept: {} };

  for (const blogID of ids || (await allBlogIDs())) {
    const result = await check(blogID, { apply });
    counts.blogs++;
    if (result.outcome === "kept") counts.kept[result.reason] = (counts.kept[result.reason] || 0) + 1;
    else counts[result.outcome]++;
    onResult(result);
  }

  return counts;
}

module.exports = { run, check, originOf, isOwnBareRepo };
