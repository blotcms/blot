const alarm = require("helper/alarm");
const clfdate = require("helper/clfdate");
const client = require("models/client");
const { isRedisUnavailableError } = require("helper/redisUnavailable");
const Blog = require("models/blog");
const folderLock = require("./lock");
const dependents = require("./update/dependents");

// What depends on a sync's files is rebuilt when the sync ends (see
// update/dependents.js). A sync killed before then (a deploy) leaves the work
// in dependents_pending, and the blog's next sync does it at its end. A blog
// which doesn't sync again would keep it for good, so each sync which records
// work also sets this alarm, and when the alarm comes due, whichever process
// claims it rebuilds what is still pending, under the folder lock. By then the
// sync has usually done the work itself, and the alarm finds nothing.
//
// One alarm per blog, alarm:due:dependents (helper/alarm). Setting it again
// replaces it, so a run of syncs keeps pushing it back.

// Long enough for the sync which set it to have finished, in most cases
const DELAY_MS = 2 * 60 * 1000;

// How long to wait before looking again while the folder is locked
const RETRY_MS = 30 * 1000;

const alarms = alarm(
  "dependents",
  async function (blogID) {
    await run(blogID);
  },
  { pollMs: 5000 }
);

function log(...args) {
  console.log(clfdate(), "Dependents alarm:", ...args);
}

// Never rejects: a failure only leaves the work for the blog's next sync
async function arm(blogID, delay = DELAY_MS) {
  try {
    await alarms.set(blogID, Date.now() + delay);
  } catch (err) {
    log(blogID, "could not set the alarm", err.message);
  }
}

// For run(): sets the alarm being handled again. Rejects if Redis can't take
// it, so the alarm keeps its claim and comes due again once the lease runs
// out, rather than being completed with the work still pending.
async function later(blogID, delay = RETRY_MS) {
  await alarms.set(blogID, Date.now() + delay);
}

// Rebuilds what is pending for the blog under its folder lock. Resolves
// either way; rejects only if Redis is unavailable, so the alarm retries.
async function run(blogID) {
  // Required when used: sync/index requires the update chain
  const sync = require("./index");

  // Checked first: the sync which holds the lock may record more work after
  // this, and it sets the alarm only once, so keep it set while that sync
  // runs. The sync rebuilds them when it ends; look again after.
  if ((await folderLock.inspect(blogID)).held) return later(blogID);

  if (!(await client.sCard(dependents.pendingKey(blogID)))) return;

  try {
    // The sync's end does the rebuild (sync/index.js done)
    await sync(blogID, async () => {});
  } catch (err) {
    if (err && err.message === "Failed to acquire folder lock")
      return later(blogID);

    // Also what a failed read of the blog gives, so look again unless the
    // blog really is deleted or disabled: then its keys go with it, or stay
    // for its next sync once it is enabled again. Blog.get rejects if Redis
    // is unavailable, so the alarm retries then.
    if (err && /^Cannot sync blog /.test(err.message)) {
      const blog = await Blog.get({ id: blogID });

      if (blog && blog.id && !blog.isDisabled) {
        log(blogID, "could not start, will retry", err.message);
        return later(blogID);
      }

      log(blogID, "not rebuilding, the blog cannot be synced");
      return;
    }

    if (isRedisUnavailableError(err)) throw err;

    log(blogID, "failed, will look again", err.message);
    return later(blogID);
  }

  // The drain never rejects: one cut short (a Redis error, a disconnect's
  // seize) leaves paths pending, so come back for them
  if (await client.sCard(dependents.pendingKey(blogID))) {
    log(blogID, "work left after the rebuild, will look again");
    return later(blogID, DELAY_MS);
  }
}

module.exports = {
  arm,
  run,
  alarm: alarms,
  start: () => alarms.start(),
  stop: () => alarms.stop(),
  DELAY_MS,
};
