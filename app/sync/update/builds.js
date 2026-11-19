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

// blogID -> Set of promises, settled or not, for the builds running in a
// batch (what queue() runs). A recheck in rebuildDependents.js waits for
// these only.
const building = new Map();

// blogID -> Set of promises for the rest of what a batch started: rechecks
// and the dependents' rebuilds nobody waits for. Only the batch waits for
// these. A recheck that waited for earlier rechecks too would hold every one
// before it, so with one slow build they would pile up behind each other.
const background = new Map();

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

// Adds promise to the blog's set in map until it settles. Returns it.
function add(map, blogID, promise) {
  let set = map.get(blogID);

  if (!set) {
    set = new Set();
    map.set(blogID, set);
  }

  const done = promise.then(
    () => {},
    () => {}
  );

  set.add(done);

  done.then(() => {
    set.delete(done);
    if (!set.size && map.get(blogID) === set) map.delete(blogID);
  });

  return promise;
}

function list(map, blogID) {
  return Array.from(map.get(blogID) || []);
}

// Counts promise, background work the batch started, as in flight for the
// blog until it settles, so the batch waits for it. Returns it.
function track(blogID, promise) {
  if (!concurrent(blogID)) return promise;

  return add(background, blogID, promise);
}

// The builds running for the blog now, as promises which never reject. Not
// the background work: see background above.
function running(blogID) {
  return list(building, blogID);
}

// Resolves once nothing is in flight for the blog, builds and background
// work, including work started while waiting
async function settled(blogID) {
  let pending;

  while (
    (pending = list(building, blogID).concat(list(background, blogID))).length
  )
    await Promise.all(pending);
}

// Runs fn, which builds path and saves (or drops) its entry, once every
// earlier build of path has finished. A file in a "+" folder is built as
// its folder, so callers pass the folder's path for it.
function queue(blogID, path, fn) {
  if (!concurrent(blogID)) return fn();

  return queues(blogID + ":" + pathNormalizer(path), () =>
    add(building, blogID, fn())
  );
}

module.exports = { batch, concurrent, queue, running, settled, track };
