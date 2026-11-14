// Removes blog folders on the macserver that no connected blog owns: a
// disconnect whose remote removal failed (iCloud refused it, or the macserver
// was down), or a blog deleted without reaching the macserver. Each one costs
// the macserver a watcher and disk. Runs daily (scheduler/index.js) and from
// scripts/icloud/sweep-orphans.js.
//
// A folder is an orphan when its blog no longer exists, or when the blog's
// client isn't iCloud and it has no iCloud account. Setup sets the client to
// iCloud before the macserver creates the folder, so a setup in progress is
// never an orphan. A deleted blog's leftover account record goes too.
//
// Any failed lookup stops the sweep before it removes anything, and a sweep
// that would remove more than MAX_REMOVALS folders, or more than MAX_FRACTION
// of them, removes none: either points at a bug, not at orphans.
const config = require("config");
const fetch = require("./util/rateLimitedFetchWithRetriesAndTimeout");

const MAX_REMOVALS = 10;
const MAX_FRACTION = 0.1;

function request(path, options = {}) {
  return fetch(config.icloud.server_address + path, {
    ...options,
    headers: { Authorization: config.icloud.secret, ...options.headers },
  });
}

async function listFolders() {
  const body = await request("/folders", { readBody: true });
  const { blogIDs } = JSON.parse(body.toString());
  if (!Array.isArray(blogIDs)) throw new Error("/folders gave no blogIDs");
  return blogIDs;
}

async function removeFolder(blogID) {
  await request("/disconnect", { method: "POST", headers: { blogID } });
}

// Why the folder is an orphan, or null if a connected blog owns it
async function orphanReason(blogID, { getBlog, getAccount }) {
  const blog = await getBlog(blogID);
  if (!blog) return "blog deleted";
  if (blog.client === "icloud") return null;
  if (await getAccount(blogID)) return null;
  return `client is ${blog.client || "none"}`;
}

// Resolves to { folders, orphans: [{ blogID, reason }], removed, failed,
// refused }. Nothing is removed unless `apply`.
async function sweepOrphans({ apply = false, deps = {} } = {}) {
  const {
    list = listFolders,
    remove = removeFolder,
    // Required here, so the scheduler and specs don't load them up front
    getBlog = (id) => require("models/blog").get({ id }),
    getAccount = (id) => require("./database").get(id),
    deleteAccount = (id) => require("./database").delete(id),
    log = console.log,
  } = deps;

  const folders = await list();
  const orphans = [];

  for (const blogID of folders) {
    const reason = await orphanReason(blogID, { getBlog, getAccount });
    if (reason) orphans.push({ blogID, reason });
  }

  const result = { folders: folders.length, orphans, removed: [], failed: [] };

  for (const { blogID, reason } of orphans)
    log(`iCloud orphan sweep: ${blogID} (${reason})`);

  if (!apply || !orphans.length) return result;

  if (
    orphans.length > MAX_REMOVALS ||
    orphans.length > folders.length * MAX_FRACTION
  ) {
    result.refused = `${orphans.length} of ${folders.length} folders look orphaned, over the limit`;
    log(`iCloud orphan sweep: removing none, ${result.refused}`);
    return result;
  }

  for (const { blogID, reason } of orphans) {
    try {
      // The blog may have reconnected since the first pass
      if (!(await orphanReason(blogID, { getBlog, getAccount }))) {
        log(`iCloud orphan sweep: ${blogID} is connected again, kept`);
        continue;
      }
      await remove(blogID);
      // A deleted blog's account record has no blog to be disconnected from
      if (reason === "blog deleted") await deleteAccount(blogID);
      result.removed.push(blogID);
      log(`iCloud orphan sweep: removed ${blogID}`);
    } catch (err) {
      result.failed.push(blogID);
      log(`iCloud orphan sweep: failed to remove ${blogID}: ${err.message}`);
    }
  }

  return result;
}

module.exports = sweepOrphans;
module.exports.MAX_REMOVALS = MAX_REMOVALS;
