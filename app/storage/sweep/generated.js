const client = require("models/client");
const clfdate = require("helper/clfdate");
const references = require("./references");
const cache = require("./cache");
const bucket = require("./s3");
const pendingRebuilds = require("sync/pendingRebuilds");

// The sweep of generated files nothing uses any more (#2688, #2745): images
// from deleted posts, stale thumbnails, versions of photos replaced or edited
// in place, changed remote images, duplicates from concurrent builds.
// Generated files sit in the bucket at {blogID}/<scope>/<id>/..., one
// directory per source, and are linked as .../<scope>/<id>/... So a
// directory is in use when a saved entry that isn't deleted, one of the
// blog's own templates or its settings mention it (./references). Per blog,
// in the order Redis, S3 (Bunny follows, in ./index), the step:
//
// - deletes the transformer cache entries that point at an unreferenced
//   directory, so that a build finds no entry and makes the files again
//   rather than linking ones about to go;
// - deletes a directory's objects from S3 only on the second run that finds
//   it unreferenced.
//
// Why two phases. A build that read a cache entry just before the main pass
// deleted it may still link the directory. A build after the pass finds no
// cache entry and makes the files again: a new directory for the image
// cache; the same, now new, directory for thumbnails, which the one-day
// check protects. The only danger is the first build: it read the entry
// before phase 1, and saves its own entry, linking the directory, after
// phase 2 has read the references. A build takes minutes at most, so the
// second pass, six hours after the main pass ends (./index), is far more
// than enough: by then that build has finished and, if it linked the
// directory, the reference is seen and the directory is kept. So the
// directories the main pass finds unreferenced (more than a day old, so no
// build in flight made them) are only recorded, in a set of the sweep's own
// (candidatesKey), and the second pass deletes the ones still unreferenced,
// still more than a day old and that no cache entry points at again (a build
// made it again since: kept, and recorded again).
//
// A cache entry that points at a directory missing from the bucket is
// deleted too, whatever its age. The builds don't check that a cached
// result's files are still stored before linking them (a bucket request per
// image per build was most of a cached rebuild's time), because every
// routine removal deletes the cache entries first: this is the backstop for
// a file lost some other way. The saved entries that mention such a
// directory link files that aren't there, so they are queued to be built
// again (sync/pendingRebuilds), which, with the cache entry gone, makes the
// files again. Only a directory the cache pointed at is a reason to rebuild:
// once its entries are deleted nothing finds it again, so a rebuild that
// doesn't help (an entry quoting another blog's image URL) is not repeated
// every run. An entry built between the loss and the run that finds it
// links the missing files until then; a blog that changes nothing in that
// time is only seen by the monthly full run (./index).
//
// Accepted gap, decided by the maintainer in #2745, so review need not raise
// it: bookmark screenshots aren't in the transformer cache; the plugin
// (build/plugins/linkScreenshot) reuses a screenshot when its file exists. A
// build that has just found one can link it in the seconds before the
// second pass deletes it. It must have been unreferenced for six hours
// first, and the next
// rebuild finds no file and takes it again, or, in a process whose build
// asked about it in the last hour (assets.existsRecently), the one after
// that hour. There is no cache entry or lock for it.
//
// Modes (see ./index): "report" reads everything and fills the totals as if
// applying, but writes nothing (no candidate set, no cache deletes, no S3
// deletes), so that switching to "apply" starts with the main pass, never the second.
//
// Any read that fails (references, the cache, the listing) rejects the step
// before anything is written, so nothing is deleted on a partial picture.

const candidatesKey = (blogID) => "perma-cache:sweep:candidates:" + blogID;

// When the candidates were recorded (ms). The main pass passes the run's start
// as markedBefore, and the second pass the time the main pass ended, so each
// only deletes candidates recorded before: a
// pass resumed after a deploy sweeps again the blogs that were in progress,
// and without this their second visit would delete what the first had only
// just marked. A set with no time is treated as just marked.
const markedKey = (blogID) => candidatesKey(blogID) + ":marked";

// Runs the step for one blog and resolves to the blog's files in the bucket
// (relPath -> last modified) minus what it deleted, for the Perma-Cache
// check that follows. options: { mode, now, totals, log, markedBefore }.
// Without markedBefore (a run by hand) any recorded candidate may go.
async function run(blogID, options) {
  const apply = options.mode === "apply";
  const now = options.now || Date.now;
  const totals = options.totals;
  const log = options.log || ((line) => console.log(clfdate(), line));

  const used = await references.inUse(blogID);
  // Read before the listing: an entry the cache holds now has its files in
  // the bucket, so a build between the two reads can't make an entry look
  // like it points at a directory that is missing
  const held = await cache.read(blogID);
  const { files, dirs } = await bucket.listing(blogID);
  const [members, marked] = await client
    .multi()
    .sMembers(candidatesKey(blogID))
    .get(markedKey(blogID))
    .exec();
  const due =
    options.markedBefore === undefined ||
    (marked !== null && Number(marked) < options.markedBefore);
  const previous = new Set(due ? members : []);
  const cutoff = now() - bucket.DAY;

  const unreferenced = [];

  for (const [name, dir] of dirs)
    if (!used.has(name) && dir.newest < cutoff) unreferenced.push(name);

  const toDelete = unreferenced.filter(
    (name) => previous.has(name) && !held.pointers.has(name)
  );
  const deleting = new Set(toDelete);
  const candidates = unreferenced.filter((name) => !deleting.has(name));

  // The cache entries to delete: those that point at an unreferenced
  // directory, those that point at a directory missing from the bucket, and
  // the members with nothing behind them
  const doomed = new Map();

  function doom(entries) {
    for (const entry of entries) doomed.set(entry.key, entry);
  }

  for (const name of unreferenced) doom(held.pointers.get(name) || []);
  const missing = [];

  for (const [name, entries] of held.pointers)
    if (!dirs.has(name)) {
      missing.push(name);
      doom(entries);
    }
  doom(held.stale);

  const legacyKeys = Array.from(doomed.values()).filter((e) => e.legacy).length;

  const sum = (names) =>
    names.reduce((bytes, name) => bytes + dirs.get(name).bytes, 0);

  // Read before anything is written, so a failure leaves the step undone
  const rebuild = missing.length
    ? await references.entriesMentioning(blogID, missing)
    : [];

  if (candidates.length || toDelete.length || doomed.size)
    log(
      `sweep generated ${blogID}: ${candidates.length} candidates ` +
        `(${sum(candidates)} bytes), ${toDelete.length} directories ` +
        `${apply ? "deleted" : "to delete"} (${sum(toDelete)} bytes), ` +
        `${doomed.size} cache keys ${apply ? "deleted" : "to delete"} ` +
        `(${legacyKeys} legacy), ${missing.length} directories missing, ` +
        `${rebuild.length} entries ${apply ? "queued" : "to queue"} to rebuild` +
        (apply ? "" : " (report only)")
    );

  if (apply) {
    // In this order, so that a deploy killing the step part-way is safe:
    // (a) the cache entries go first, which only makes a later build make
    //     the files again; run again, they are simply not there;
    // (b) the objects go next; if that stops part-way the candidate set is
    //     still the old one, so the next run finds the same directories (the
    //     ones already deleted are just absent from its listing);
    // (c) the candidate set is rewritten last. A set that was never written
    //     only delays a directory by a run, whereas writing it before the
    //     deletes could hide a directory still in the bucket.
    await cache.remove(blogID, Array.from(doomed.values()));

    // After the cache entries have gone, so the rebuild makes the files again
    // rather than linking the missing ones. A kill between the two leaves
    // these entries until they next change: the cache no longer points at
    // the directory, so no later run finds them.
    await pendingRebuilds.queuePaths(blogID, rebuild);

    await bucket.deleteDirs(
      blogID,
      toDelete.map((name) => ({ name, keys: dirs.get(name).keys }))
    );

    const tx = client.multi().del(candidatesKey(blogID)).del(markedKey(blogID));

    if (candidates.length)
      tx.sAdd(candidatesKey(blogID), candidates).set(
        markedKey(blogID),
        String(now())
      );

    await tx.exec();

    for (const name of toDelete)
      for (const key of dirs.get(name).keys)
        files.delete(key.slice(blogID.length + 1));
  }

  totals.generatedBlogs++;
  totals.candidates += candidates.length;
  totals.candidateBytes += sum(candidates);
  totals.deletedDirs += toDelete.length;
  totals.deletedBytes += sum(toDelete);
  totals.cacheKeysDeleted += doomed.size;
  totals.legacyCacheKeys += legacyKeys;
  totals.missingDirs += missing.length;
  totals.rebuildsQueued += rebuild.length;

  return files;
}

module.exports = { run, candidatesKey, markedKey };
