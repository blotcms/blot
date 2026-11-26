const alarm = require("helper/alarm");
const clfdate = require("helper/clfdate");
const { isRedisUnavailableError } = require("helper/redisUnavailable");
const client = require("models/client");
const Blog = require("models/blog");
const folderLock = require("./lock");

// Whole-blog rebuilds which must finish even if the process running them is
// killed (a deploy). A settings change (link format, plugins, image metadata,
// converters) or the dashboard's Rebuild button queues one: the work it asks
// for is written to Redis first, then run under the blog's folder lock, so a
// deploy's drain waits for it and two runs never overlap. The record is
// cleared only once the work is done, so a run cut off part way is started
// again, from scratch, by whichever process next finds the lock free.
//
//   await pendingRebuilds.request(blogID, ["rebuild"]);
//
// What is asked for is a set of flags, merged with whatever is already
// waiting for the blog:
//   resave      save every entry again (a link format change)
//   rebuild     build every file again (plugins, image metadata, converters)
//   thumbnails  with rebuild, wipe the thumbnails first
//   imageCache  with rebuild, wipe the cached images first
//   fix         run Fix() afterwards (the dashboard's Rebuild)
//
// or, with queuePaths, single paths to build again (members "path:<path>"),
// which a whole rebuild queued with them already covers.
//
// Keys, under the blog's namespace so deleting the blog removes them:
//   blog:<id>:rebuild:pending   flags queued and not yet started
//   blog:<id>:rebuild:running   flags a run has taken; left by a killed run
//   blog:<id>:rebuild:attempts  runs started for what is in running
// and the alarm alarm:due:pending-rebuilds, one per blog, which any process
// claims (helper/alarm) to run what is waiting once the lock is free.
const FLAGS = ["resave", "rebuild", "thumbnails", "imageCache", "fix"];
const PATH = "path:";

// A run killed this many times in a row (by a deploy, or by the rebuild
// itself crashing the process) is given up on rather than tried forever
const MAX_ATTEMPTS = 3;

// How long to wait before looking again while the blog's folder is locked
const RETRY_MS = 15 * 1000;

function pendingKey(blogID) {
  return "blog:" + blogID + ":rebuild:pending";
}

function runningKey(blogID) {
  return "blog:" + blogID + ":rebuild:running";
}

function attemptsKey(blogID) {
  return "blog:" + blogID + ":rebuild:attempts";
}

function log(...args) {
  console.log(clfdate(), "Pending rebuild:", ...args);
}

function isLocked(err) {
  return !!err && err.message === "Failed to acquire folder lock";
}

function cannotSync(err) {
  return !!err && /^Cannot sync blog /.test(err.message);
}

const alarms = alarm(
  "pending-rebuilds",
  async function (blogID) {
    await run(blogID);
  },
  { pollMs: 5000 }
);

// Writes the flags to Redis, with an alarm due now so that some process runs
// them even if this one dies before it does. Resolves once both are stored;
// rejects if Redis can't take them.
async function queue(blogID, flags) {
  flags = (flags || []).filter(Boolean);

  for (const flag of flags) {
    if (FLAGS.indexOf(flag) === -1)
      throw new TypeError("pendingRebuilds: unknown flag " + flag);
  }

  if (!flags.length) return;

  const multi = client.multi().sAdd(pendingKey(blogID), flags);
  await alarms.queueSet(multi, blogID, Date.now()).exec();
}

// Queues single paths of the blog to build again, as queue does flags
async function queuePaths(blogID, paths) {
  paths = (paths || []).filter(Boolean);

  for (const path of paths) {
    if (typeof path !== "string" || path[0] !== "/")
      throw new TypeError("pendingRebuilds: not a path " + path);
  }

  if (!paths.length) return;

  const multi = client.multi().sAdd(
    pendingKey(blogID),
    paths.map((path) => PATH + path)
  );
  await alarms.queueSet(multi, blogID, Date.now()).exec();
}

// Takes what is queued for the blog, together with anything a killed run
// left, and does it. The caller must hold the blog's folder lock (see run),
// which is what keeps two runs apart. folder is the sync's { status, log }.
// Resolves once the work is done and the record cleared. Rejects only if
// Redis is unavailable, leaving the record for a later run.
async function runLocked(blogID, folder) {
  // Atomic, so a flag queued meanwhile is either taken now or left pending
  const [, , flagList, attempts] = await client
    .multi()
    .sUnionStore(runningKey(blogID), [runningKey(blogID), pendingKey(blogID)])
    .del(pendingKey(blogID))
    .sMembers(runningKey(blogID))
    .incr(attemptsKey(blogID))
    .exec();

  const flags = new Set(flagList || []);

  if (!flags.size) return clear(blogID);

  if (Number(attempts) > MAX_ATTEMPTS) {
    log(blogID, "giving up after", MAX_ATTEMPTS, "attempts:", [...flags]);
    return clear(blogID);
  }

  const named = [...flags].filter((flag) => !flag.startsWith(PATH));
  const paths = flags.size - named.length;

  log(
    blogID,
    "running",
    paths ? [...named, paths + " paths"] : named,
    "attempt",
    Number(attempts)
  );

  try {
    await work(blogID, flags, folder);
  } catch (err) {
    // Redis is unavailable: leave the record for a later run
    if (isRedisUnavailableError(err)) throw err;
    // Anything else would fail the same way again
    log(blogID, "failed", err);
  }

  await clear(blogID);
}

async function work(blogID, flags, folder) {
  const { status, log: folderLog } = folder;
  const rebuild = flags.has("rebuild") || flags.has("fix");

  // A rebuild saves every entry too, which also applies a link format change,
  // but only those with a file to build: resave reaches every stored entry
  if (flags.has("resave")) {
    await require("models/entries").resave(blogID);
    // Render caches are keyed on the cacheID (see sync/rebuild.js)
    if (!rebuild) await Blog.set(blogID, { cacheID: Date.now() });
  }

  if (rebuild) {
    if (flags.has("fix")) status("Rebuilding your site");

    try {
      await require("./rebuild")(blogID, {
        thumbnails: flags.has("thumbnails"),
        imageCache: flags.has("imageCache"),
        status,
        log: folderLog,
      });
    } catch (err) {
      // Fix() still runs after a rebuild which failed
      if (isRedisUnavailableError(err) || !flags.has("fix")) throw err;
      console.log(err);
    }
  }

  const paths = [...flags]
    .filter((flag) => flag.startsWith(PATH))
    .map((flag) => flag.slice(PATH.length));

  if (paths.length && !rebuild)
    await require("./rebuild")(blogID, { paths, status, log: folderLog });

  if (flags.has("fix")) {
    status("Checking your site for issues");

    const blog = await Blog.get({ id: blogID });
    let report;

    try {
      report = await require("./fix")(blog, { status, log: folderLog });
    } catch (err) {
      if (isRedisUnavailableError(err)) throw err;
      console.log(err);
      report = err.report;
    }

    // Fix() doesn't email; a rebuild only logs what it repaired
    const repaired = require("clients/util/syncReport").summarize(report);
    if (repaired) console.log("Fix repaired", blogID, repaired);
    status("Finished site rebuild");
  }
}

// Removes the run's record. A blog queued meanwhile keeps its pending flags,
// and the alarm that queued them.
async function clear(blogID) {
  await client.multi().del(runningKey(blogID)).del(attemptsKey(blogID)).exec();
}

// Runs what is waiting for the blog under its folder lock. While another sync
// holds the lock, the alarm is set to look again shortly. Resolves either
// way; rejects only if Redis is unavailable, so the alarm retries it.
async function run(blogID) {
  // Required when used: sync/index requires the update chain, which is not
  // needed to queue a rebuild
  const sync = require("./index");

  // Already done, by the run that queued it: no need to take the lock
  if (!(await pending(blogID)).length) return;

  // Skips sync's own retries while the lock is visibly held
  if ((await folderLock.inspect(blogID)).held) return later(blogID);

  try {
    await sync(blogID, (folder) => runLocked(blogID, folder));
  } catch (err) {
    if (isLocked(err)) return later(blogID);

    // The blog is gone or disabled: nothing to rebuild. Blog.get rejects
    // if Redis is unavailable, so the alarm retries then.
    if (cannotSync(err)) {
      const blog = await Blog.get({ id: blogID });

      if (blog && blog.id && !blog.isDisabled) {
        log(blogID, "could not start, will retry", err.message);
        return later(blogID);
      }

      log(blogID, "dropped, the blog cannot be synced");
      await client
        .multi()
        .del(pendingKey(blogID))
        .del(runningKey(blogID))
        .del(attemptsKey(blogID))
        .exec();
      return;
    }

    if (isRedisUnavailableError(err)) throw err;

    // Finishing the sync failed. Look again: if the work was done its record
    // is gone, and the next run stops at the check above.
    log(blogID, "failed, will look again", err);
    return later(blogID);
  }
}

// Setting the alarm again while it is being handled keeps the new time, so
// the alarm survives the handler that found the lock held
async function later(blogID) {
  await alarms.set(blogID, Date.now() + RETRY_MS);
}

// For a page which saved a setting and doesn't wait for the rebuild: queues
// the flags, then starts the run in this process. Never rejects, since the
// setting is saved whatever happens to the rebuild; a failure is logged.
async function request(blogID, flags) {
  try {
    await queue(blogID, flags);
  } catch (err) {
    log(blogID, "could not queue", flags, err);
    return;
  }

  run(blogID).catch((err) => log(blogID, "failed, will retry", err));
}

// Whether anything is queued or left by a killed run, for tests and scripts
async function pending(blogID) {
  const [queued, running] = await client
    .multi()
    .sMembers(pendingKey(blogID))
    .sMembers(runningKey(blogID))
    .exec();
  return [...new Set([...(queued || []), ...(running || [])])].sort();
}

module.exports = {
  queue,
  queuePaths,
  request,
  run,
  runLocked,
  pending,
  alarm: alarms,
  start: () => alarms.start(),
  stop: () => alarms.stop(),
  pendingKey,
  runningKey,
  attemptsKey,
  MAX_ATTEMPTS,
};
