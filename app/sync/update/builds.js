// Keeps the builds of one blog's files in order while a sync builds several
// at once (sync/updateAll.js). Outside such a batch every function here
// passes straight through, so a sync which updates its files one at a time
// runs as it always has.
//
// Entry.set is safe for several entries at once (models/entry/set.js queues
// each blog's saves). What it can't see is the build before the save: a
// build reads the folder and Redis when it starts, so a build which started
// before another file was saved can store an entry made from the old state,
// and store it last. What here prevents that:
//
// - queue() runs one build-and-save of an entry at a time. The sync's own
//   update of a file, a rebuild of it as another file's dependent and its
//   drop all go through it, keyed by the entry they build (entryPath), so
//   the last build of an entry to start is the last to save, and it started
//   after whatever asked for it was saved.
//
// - track() and settled() hold the batch open until everything it started
//   has finished: the rebuilds of dependents which aren't waited for (the
//   wikilink keys in set.js) and the re-checks in rebuildDependents.js. A
//   Redis outage in any of them fails the batch, as it would have failed
//   the update in series.
//
// - Once all that has settled, the batch adds the backlinks that saving in
//   series would have: an entry saved before the entry it links to, in the
//   same batch, found nothing to add its backlink to (see reconcile).
//
// Like Entry.set's queue this is per process, which holds for a sync: it
// runs in the process holding the blog's folder lock.
const serialByKey = require("helper/serialByKey");
const pathNormalizer = require("helper/pathNormalizer");
const clfdate = require("helper/clfdate");
const build = require("build");
const Entry = require("models/entry");
const { isRedisUnavailableError } = require("helper/redisUnavailable");

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

// blogID -> Set of the entry paths built or dropped in the batch
const built = new Map();

// blogID -> the first Redis outage met by work the batch started
const failures = new Map();

function concurrent(blogID) {
  return batches.has(blogID);
}

// The entry a path builds or drops: a file in a "+" folder, and the folder
// itself, build the folder's post at the path without the "+". So replacing
// "/article.md+" with "/article.md", or the reverse, is one entry.
function entryPath(path) {
  const multiInfo = build.findMultiFolder(path);

  return pathNormalizer(multiInfo ? multiInfo.entryPath : path);
}

// Runs fn as a concurrent batch for the blog, then waits for what the batch
// started to finish. Rejects with what fn threw, or else with a Redis outage
// met by the work it started.
async function batch(blogID, fn) {
  batches.set(blogID, (batches.get(blogID) || 0) + 1);

  let result;
  let error = null;

  try {
    result = await fn();
  } catch (err) {
    error = err;
  }

  await settled(blogID);

  const failure = await leave(blogID);

  if (error) throw error;
  if (failure) throw failure;

  return result;
}

// Ends a batch. The last batch for the blog adds the missing backlinks and
// clears what the batches recorded. Resolves to a Redis outage met by the
// batch's work, or null.
async function leave(blogID) {
  const left = batches.get(blogID) - 1;

  if (left) {
    batches.set(blogID, left);
    return failures.get(blogID) || null;
  }

  if (!failures.has(blogID)) await reconcile(blogID);

  const failure = failures.get(blogID) || null;

  batches.delete(blogID);
  built.delete(blogID);
  failures.delete(blogID);

  return failure;
}

function fail(blogID, err) {
  if (!failures.has(blogID)) failures.set(blogID, err);
}

// A save adds its entry's backlink to each entry it links to that exists.
// In series, an entry linking to one created later in the same sync gets
// its backlink if the target is saved first, as the order of the changes
// usually has it. Building at once, the linker can be saved first. So once
// the batch has settled, each entry built in it adds the backlinks it can
// now (Entry.set.addBacklinks only adds, through Entry.set's queue), one at
// a time.
async function reconcile(blogID) {
  const paths = Array.from(built.get(blogID) || []);

  for (const path of paths) {
    try {
      await Entry.set.addBacklinks(blogID, path);
    } catch (err) {
      if (isRedisUnavailableError(err)) return fail(blogID, err);

      console.log(
        clfdate(),
        blogID.slice(0, 12),
        "Error adding backlinks:",
        path,
        err
      );
    }
  }
}

// Adds promise to the blog's set in map until it settles, and records a
// Redis outage it rejects with. Returns it.
function add(map, blogID, promise) {
  let set = map.get(blogID);

  if (!set) {
    set = new Set();
    map.set(blogID, set);
  }

  const done = (async () => {
    try {
      await promise;
    } catch (err) {
      if (isRedisUnavailableError(err)) fail(blogID, err);
    }
  })();

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
// earlier build of the same entry has finished (see entryPath)
function queue(blogID, path, fn) {
  if (!concurrent(blogID)) return fn();

  const key = entryPath(path);

  if (!built.has(blogID)) built.set(blogID, new Set());
  built.get(blogID).add(key);

  return queues(blogID + ":" + key, () => add(building, blogID, fn()));
}

module.exports = {
  batch,
  concurrent,
  entryPath,
  queue,
  running,
  settled,
  track,
};
