const alarm = require("helper/alarm");
const client = require("models/client");
const folderLock = require("sync/lock");
const clfdate = require("helper/clfdate");

// How long to wait before trying a blog again while another sync holds its
// folder lock
const RETRY_MS = 5000;

// How long a follow-up written ahead of a change (see arm) waits before any
// process runs it. The change normally syncs straight away and takes the
// follow-up back, so this only has to be longer than a typical sync.
const ARM_MS = 15 * 1000;

// A blog's dirty flag (see run) is a safety net, not state: if nothing reads
// it, it goes away on its own after this long.
const DIRTY_TTL_SECONDS = 5 * 60;

// How many times in a row run() syncs again straight away because changes
// arrived during the sync, before leaving the rest to the follow-up alarm
const MAX_REPEATS = 5;

const instances = [];

function isLocked(err) {
  return !!err && err.message === "Failed to acquire folder lock";
}

// Runs a client's sync for a blog when a webhook or push says it changed,
// and makes sure the change is picked up even when a sync is already
// running, in this process or any other. The running sync may have walked
// past the change already, so instead of dropping the request we leave a
// follow-up in Redis (see helper/alarm) for any process to run once the
// lock is free. However many requests arrive meanwhile, a blog has at most
// one follow-up waiting, and a process that dies while running one leaves
// it to be retried elsewhere.
//
//   const followUps = followUpSync("dropbox", (blogID) => syncBlog(blogID));
//   await followUps.run(blogID);
//
// syncBlog(blogID) must return a promise which rejects with sync's "Failed
// to acquire folder lock" error when the blog's folder is locked. Every
// instance polls once startAll() is called, which setup does in every
// process.
function followUpSync(name, syncBlog) {
  function log(...args) {
    console.log(clfdate(), "Follow-up sync:", name, ...args);
  }

  const alarms = alarm(
    name + "-follow-up-sync",
    async function (blogID) {
      log("Running follow-up sync", blogID);
      await attempt(blogID);
    },
    { pollMs: 2000 }
  );

  async function later(blogID) {
    // Setting the alarm again while it is being handled keeps the new time,
    // so this also re-queues a follow-up whose own sync found the lock busy
    await alarms.set(blogID, Date.now() + RETRY_MS);
  }

  // sync:follow-up:dirty:<name>:<blogID> exists while a request has found the
  // blog's lock held and not yet been caught up with by a sync
  function dirtyKey(blogID) {
    return "sync:follow-up:dirty:" + name + ":" + blogID;
  }

  // The lock is held: set the dirty flag and the follow-up in one MULTI. The
  // flag holds the time the alarm is due, so it always names the alarm the
  // last request set.
  async function queue(blogID) {
    const due = Date.now() + RETRY_MS;
    const multi = client
      .multi()
      .set(dirtyKey(blogID), String(due), { EX: DIRTY_TTL_SECONDS });
    await alarms.queueSet(multi, blogID, due).exec();
  }

  // Reads and clears the dirty flag. Resolves the due time of the alarm the
  // requests which set it left behind, or null if there was no flag. It leaves
  // the alarm alone: run() takes that back only once the sync run again has
  // succeeded.
  async function takeDirty(blogID) {
    const flag = await client.getDel(dirtyKey(blogID));
    if (flag === null || flag === undefined) return null;
    const due = Number(flag);
    return Number.isFinite(due) ? due : null;
  }

  // Resolves "synced" if the sync ran, "locked" if it found the lock taken
  // (a follow-up is queued) and "failed" if it threw anything else
  async function attempt(blogID) {
    try {
      await syncBlog(blogID);
      return "synced";
    } catch (err) {
      if (isLocked(err)) {
        await later(blogID);
        return "locked";
      }
      log("Sync failed", blogID, err);
      return "failed";
    }
  }

  // For a change which is about to be acknowledged to its sender: leaves a
  // follow-up in Redis first, so that a process which dies before it has
  // synced the change does not lose it. Resolves to a token to pass to run()
  // once the change has been handed to it. Rejects if Redis can't take it.
  //
  // A follow-up already waiting will sync this change too, and may be all that
  // syncs an earlier one, so it is left alone, and there is no token.
  async function arm(blogID) {
    if ((await alarms.when(blogID)) !== null) return undefined;

    // The fraction makes the time ours alone, so run() can take back only
    // this follow-up and not one written since
    const due = Date.now() + ARM_MS + Math.random();
    await alarms.set(blogID, due);
    return due;
  }

  // Syncs the blog now, unless a sync is already running, in which case a
  // follow-up runs once it has finished. Skipping the lock's own retries
  // when it is visibly held means a burst of webhooks during one sync
  // collapses straight into the one follow-up.
  //
  // If the change was armed, its token is passed too, and once the sync has
  // run the follow-up is taken back, unless another has been written since.
  async function run(blogID, armed, repeats = 0) {
    const { held } = await folderLock.inspect(blogID);

    if (held) {
      log("Sync already running, queueing follow-up", blogID);
      return queue(blogID);
    }

    const result = await attempt(blogID);

    if (result !== "synced") return;

    if (armed !== undefined) {
      await alarms
        .cancelIf(blogID, armed)
        .catch((err) => log("Could not take back follow-up", blogID, err));
    }

    // The sync has released the lock. Requests which found it held while it
    // ran may have been walked past by it, so rather than leave them to the
    // follow-up alarm, which waits RETRY_MS, sync again now.
    //
    // The sync run again takes over the alarm those requests set, and takes it
    // back (cancelIf, as for an armed change) only once it has succeeded. If it
    // fails, or the process dies, the alarm is still there to retry it. A
    // request which arrives later moves the alarm and sets the flag again, so
    // the alarm is kept and the next takeDirty sees the flag; a Git arm moves
    // it to its own time, so it is kept too. If the alarm fires while the sync
    // run again still holds the lock, its follow-up finds the lock held and
    // queues again, which costs at most one more cycle, within MAX_REPEATS. A
    // failed first sync never gets here, so its alarm retries it.
    let due;
    try {
      due = await takeDirty(blogID);
    } catch (err) {
      log("Could not read dirty flag", blogID, err);
      return;
    }

    if (due === null) return;

    if (repeats >= MAX_REPEATS) {
      log(
        "Changes keep arriving during syncs, leaving the rest to a follow-up",
        blogID
      );
      return later(blogID);
    }

    log("Changes arrived during the sync, syncing again", blogID);
    return run(blogID, due, repeats + 1);
  }

  // For the clients' test-only syncs-finished routes: whether a follow-up is
  // still waiting for the blog. Setup doesn't run in tests, so nothing else
  // polls there; this starts a poll to run any follow-up that is due.
  async function pending(blogID) {
    if ((await alarms.when(blogID)) === null) return false;
    alarms.poll().catch((err) => log("Poll failed", err));
    return true;
  }

  const instance = { run, arm, pending, alarm: alarms };
  instances.push(instance);
  return instance;
}

followUpSync.startAll = function () {
  for (const { alarm } of instances) alarm.start();
};

followUpSync.stopAll = function () {
  return Promise.all(instances.map(({ alarm }) => alarm.stop()));
};

module.exports = followUpSync;
