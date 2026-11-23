// Whether err is how a sync stops once its folder lock's signal has aborted
// (sync/seize.js, for a disconnect): the signal's own error (code
// ECANCELED), a request the signal cut off (node-fetch's AbortError), or a
// reset's AbortError between steps. With signal, also whenever it has
// aborted, whatever the error. Nothing is persisted or retried for these.
module.exports = function cancelled(err, signal) {
  if (signal && signal.aborted) return true;
  return !!err && (err.code === "ECANCELED" || err.name === "AbortError");
};
