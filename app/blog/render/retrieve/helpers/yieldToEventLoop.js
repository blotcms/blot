// Resolves on the next macrotask, so requests and timers already waiting get
// to run. Cache fills chain several synchronous passes over a whole blog's
// entries (clone, augment, size) through promise continuations, which all run
// in one tick; awaiting this between the passes splits that into separate
// blocks of the event loop. Only call it on a cache miss - a hit shouldn't
// pay a macrotask hop.
module.exports = function yieldToEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
};
