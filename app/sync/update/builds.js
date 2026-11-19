// Keeps the builds of one blog's files in order while a sync builds several
// at once (sync/updateAll.js). Outside such a batch every function here
// passes straight through, so a sync which updates its files one at a time
// runs as it always has.
//
// Entry.set is safe for several entries at once (models/entry/set.js queues
// each blog's saves). What it can't see is the build before the save: a
// build reads the folder and Redis when it starts, so a build which started
// before another file was saved can store an entry made from the old state,
// and store it last. Two things here prevent that:
//
// - queue() runs one build-and-save of a path at a time. The sync's own
//   update of a file, a rebuild of it as another file's dependent and its
//   drop all go through it, so the last build of a path to start is the last
//   to save, and it started after whatever asked for it was saved.
//
// - track() and settled() hold the batch open until everything it started
//   has finished: the rebuilds of dependents which aren't waited for (the
//   wikilink keys in set.js) and the re-checks in rebuildDependents.js.
//
// Like Entry.set's queue this is per process, which holds for a sync: it
// runs in the process holding the blog's folder lock.
const serialByKey = require("helper/serialByKey");
const pathNormalizer = require("helper/pathNormalizer");

const queues = serialByKey();

// blogID -> how many concurrent batches are running for it
const batches = new Map();

// blogID -> Set of promises for work started during a batch, settled or not
const inFlight = new Map();

function concurrent(blogID) {
  return batches.has(blogID);
}

// Runs fn as a concurrent batch for the blog, then waits for what the batch
// started to finish
async function batch(blogID, fn) {
  batches.set(blogID, (batches.get(blogID) || 0) + 1);

  try {
    return await fn();
  } finally {
    await settled(blogID);

    const left = batches.get(blogID) - 1;
    if (left) batches.set(blogID, left);
    else batches.delete(blogID);
  }
}

// Counts promise as in flight for the blog until it settles. Returns it.
function track(blogID, promise) {
  if (!concurrent(blogID)) return promise;

  let set = inFlight.get(blogID);

  if (!set) {
    set = new Set();
    inFlight.set(blogID, set);
  }

  const done = promise.then(
    () => {},
    () => {}
  );

  set.add(done);

  done.then(() => {
    set.delete(done);
    if (!set.size && inFlight.get(blogID) === set) inFlight.delete(blogID);
  });

  return promise;
}

// The work in flight for the blog now, as promises which never reject
function running(blogID) {
  return Array.from(inFlight.get(blogID) || []);
}

// Resolves once nothing is in flight for the blog, including work started
// while waiting
async function settled(blogID) {
  let pending;

  while ((pending = running(blogID)).length) await Promise.all(pending);
}

// Runs fn, which builds path and saves (or drops) its entry, once every
// earlier build of path has finished. A file in a "+" folder is built as
// its folder, so callers pass the folder's path for it.
function queue(blogID, path, fn) {
  if (!concurrent(blogID)) return fn();

  return queues(blogID + ":" + pathNormalizer(path), () => track(blogID, fn()));
}

module.exports = { batch, concurrent, queue, running, settled, track };
