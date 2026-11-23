const { AsyncLocalStorage } = require("async_hooks");

// Refuses writes to a blog's folder from a sync whose lock was seized
// (sync/seize.js). sync() and hold() run their function inside run(), with
// the lock's AbortSignal; the folder's write methods (./index.js) call
// check() first, which throws the signal's reason once it has aborted. So a
// sync that disconnect has cancelled can't change the folder afterwards,
// whichever client code it is in.
//
// Only code started inside the function sees the signal. A caller of
// establishSyncLock, which carries on outside the function that took the
// lock, wraps its code in folder.run() or checks folder.signal itself.

const storage = new AsyncLocalStorage();

// A context can outlive its fn: a module-level queue runs each job in the
// context of whatever settled before it, which may be an earlier sync's. So
// a context stops counting once fn has settled, and work fn started without
// waiting for it loses the guard.
async function run(blogID, signal, fn) {
  const store = { blogID, signal, active: true };
  try {
    return await storage.run(store, fn);
  } finally {
    store.active = false;
  }
}

function check(blogID) {
  const store = storage.getStore();
  if (
    store &&
    store.active &&
    store.blogID === blogID &&
    store.signal.aborted
  ) {
    throw store.signal.reason;
  }
}

// The same for a client's own records of a blog (its account, its mapping of
// the folder), which aren't always keyed by blogID: throws if this code runs
// for a sync whose lock was seized, whichever blog it is
function throwIfAborted() {
  const store = storage.getStore();
  if (store && store.active && store.signal.aborted) throw store.signal.reason;
}

module.exports = { run, check, throwIfAborted };
