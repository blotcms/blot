// No-op stand-in for app/sync/lock.js (drain.js only needs these four).
module.exports = {
  stopAcquiring() {},
  resumeAcquiring() {},
  heldCount: () => 0,
  releaseAll: () => Promise.resolve(),
};
