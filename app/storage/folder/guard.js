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
// lock, has to check folder.signal itself.

const storage = new AsyncLocalStorage();

function run(blogID, signal, fn) {
  return storage.run({ blogID, signal }, fn);
}

function check(blogID) {
  const store = storage.getStore();
  if (store && store.blogID === blogID && store.signal.aborted) {
    throw store.signal.reason;
  }
}

module.exports = { run, check };
