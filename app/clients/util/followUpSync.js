const alarm = require("helper/alarm");
const folderLock = require("sync/lock");
const clfdate = require("helper/clfdate");

// How long to wait before trying a blog again while another sync holds its
// folder lock
const RETRY_MS = 5000;

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

  async function attempt(blogID) {
    try {
      await syncBlog(blogID);
    } catch (err) {
      if (isLocked(err)) return later(blogID);
      log("Sync failed", blogID, err);
    }
  }

  // Syncs the blog now, unless a sync is already running, in which case a
  // follow-up runs once it has finished. Skipping the lock's own retries
  // when it is visibly held means a burst of webhooks during one sync
  // collapses straight into the one follow-up.
  async function run(blogID) {
    const { held } = await folderLock.inspect(blogID);

    if (held) {
      log("Sync already running, queueing follow-up", blogID);
      return later(blogID);
    }

    return attempt(blogID);
  }

  // For the clients' test-only syncs-finished routes: whether a follow-up is
  // still waiting for the blog. Setup doesn't run in tests, so nothing else
  // polls there; this starts a poll to run any follow-up that is due.
  async function pending(blogID) {
    if ((await alarms.when(blogID)) === null) return false;
    alarms.poll().catch((err) => log("Poll failed", err));
    return true;
  }

  const instance = { run, pending, alarm: alarms };
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
