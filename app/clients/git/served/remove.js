// Removes a blog's repository from the git store, <blogID>/git/ in the storage
// bucket, when its git client is disconnected or the blog is deleted
// (disconnect.js, through repo.remove).
//
//   removeBlog(blogID)   resolves once the copy is removed; never rejects, a
//                        failure is logged
//   isRemoved(blogID)    whether this process is removing the blog's copy, so
//                        background work for it (./upkeep.js) is not started
//
// The store's removeRepo deletes every pack, then writes a tombstone manifest:
// the manifests stay, so the numbering never starts again at 1 under another
// process. The copy is removed again a while later, unless the blog is back on
// git by then, for work another process (the other unit) had already started
// when the blog was disconnected. What that misses, the monthly orphan sweep
// (./maintenance.js) deletes.
//
// One line per pass:
//
//   [git-store-served] blog=<id> op=remove outcome=ok|error|spared deleted=... pass=1|2
const removeRepo = require("../store/remove");
const context = require("./context");
const upkeep = require("./upkeep");
const log = require("./log");

// Blogs whose store copy is being or has been removed in this process, with
// when: background work for them is not started until the second pass
const removed = new Map();

// How long after removing a store copy it is removed again
const REMOVE_AGAIN_MS = 5 * 60 * 1000;

// The second passes waiting to run, timer to pass, so _reset() can cancel them
// (a spec's disconnect would otherwise reach into a spec running minutes later)
// and _runAgainNow() can run them without waiting
const removeAgainTimers = new Map();

function detail(err) {
  return String((err && (err.code || err.message)) || "error");
}

// Resolves with the number of keys deleted, or null with no bucket
async function deleteCopy(blogID) {
  if (!context.hasStore()) return null;

  const { deleted } = await removeRepo({
    store: context.objectStoreFor(blogID),
  });

  return deleted;
}

async function deleteAndLog(blogID, pass) {
  try {
    const deleted = await deleteCopy(blogID);
    if (deleted)
      log({ blog: blogID, op: "remove", outcome: "ok", deleted, pass });
  } catch (err) {
    log({
      blog: blogID,
      op: "remove",
      outcome: "error",
      pass,
      detail: detail(err),
    });
  }
}

async function removeBlog(blogID) {
  removed.set(blogID, Date.now());

  try {
    // A compaction running for the blog finishes first, and none starts now
    await upkeep.idle(blogID);
    context.forget(blogID);
  } catch (err) {
    log({ blog: blogID, op: "remove", outcome: "error", detail: detail(err) });
  }

  await deleteAndLog(blogID, 1);

  const again = setTimeout(() => {
    removeAgainTimers.delete(again);
    removeAgain(blogID);
  }, REMOVE_AGAIN_MS);

  removeAgainTimers.set(again, () => removeAgain(blogID));
  if (again.unref) again.unref();
}

async function removeAgain(blogID) {
  let blog;
  let lookupError = null;

  try {
    blog = await require("models/blog").get({ id: blogID });
  } catch (err) {
    lookupError = err;
  }

  // Back on git: its new copy is not ours to delete. A failed lookup
  // doesn't say it is gone, so the copy is kept: the monthly orphan sweep
  // deletes it if the blog is still off git.
  if (lookupError)
    log({
      blog: blogID,
      op: "remove",
      outcome: "spared",
      pass: 2,
      detail: detail(lookupError),
    });
  else if (!blog || blog.client !== "git") await deleteAndLog(blogID, 2);
  removed.delete(blogID);
}

function isRemoved(blogID) {
  return removed.has(blogID);
}

// For specs: runs the waiting second passes now, and resolves when they are done
async function _runAgainNow() {
  const pending = [...removeAgainTimers];
  removeAgainTimers.clear();
  pending.forEach(([timer]) => clearTimeout(timer));
  await Promise.all(pending.map(([, run]) => run()));
}

function _reset() {
  removed.clear();
  removeAgainTimers.forEach((run, timer) => clearTimeout(timer));
  removeAgainTimers.clear();
}

module.exports = { removeBlog, isRemoved, _runAgainNow, _reset };
