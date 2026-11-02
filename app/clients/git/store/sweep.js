// The sweep: deletes old manifests, and the packs no kept manifest names. It
// is the only thing in the store that deletes, so it is written to delete
// too little rather than too much. It never runs on the push path; the host
// runs it on a schedule of its own (daily, say).
//
//   const stats = await sweep({ store });
//
//   store           the repository's object store (see objectStore/memory.js)
//   now             the time, in ms (default Date.now()); specs move it on
//   grace           how long a pack must have been unnamed, and unwritten,
//                   before it is deleted (default 24 hours, far longer than
//                   any push or clone); no less than an hour is accepted
//   keepManifests   the newest manifests always kept (default 20)
//   recoveryWindow  manifests written in this long are kept too (default 7
//                   days), and so the packs they name, so one can be put
//                   back by hand; at least two days (see MIN_RECOVERY_WINDOW)
//
// Manifests. manifests/<n>.json is deleted when n is at least keepManifests
// below the newest seq and it was written longer than recoveryWindow ago.
// latest.json is never touched. A kept manifest is any other one.
//
// Packs, in two phases on different runs, with a record in between
// (sweep/pending.json: each marked pack's name, when it was marked, and the
// last-modified time of each of its files as the listing showed it).
//
//   1. Mark. A pack (its .pack, .idx and .rev, whichever are there) that no
//      kept manifest names, all of whose files were last written more than
//      `grace` ago, is added to the record. Nothing is deleted.
//   2. Delete. On a later run, a pack marked at least `grace` ago is looked at
//      again: the manifests are read forward from the newest this run has seen
//      (a HEAD for the next seq, and a GET of any found); if a kept manifest
//      now names it, it is dropped from the record. Otherwise each of its files
//      is HEADed, and only if each is unchanged since the mark (the same
//      last-modified, to the second, and no file that was not there) are they
//      deleted. Just before the DELETEs, the newest manifest is checked not to
//      name it, as an assertion that throws.
//
// Why two phases: a pack no manifest names may be one a push has uploaded and
// not yet swapped in, and packs are named by their content, so a later push
// (or compaction) can upload the very same bytes under a name that is an
// orphan now, and name it without anyone HEADing it. A pack must be unnamed
// and unwritten for `grace` before it is marked, and stay so for `grace` after,
// and an upload of the same name in the meantime changes its last-modified,
// which spares it. The window left is between a file's HEAD and its DELETE:
// an upload of the same bytes that lands in those milliseconds, by a push that
// then swaps, is deleted under it. See "Pruning and the sweep" in the README.
//
// Two sweeps at once are safe. Every deletion is guarded by the checks above,
// which do not depend on the record being up to date: a record that loses a
// mark (last writer wins) only delays a deletion to a later mark, and one that
// keeps a stale mark only costs a HEAD, since a pack written since the mark is
// spared and one already deleted is dropped.
//
// Requests. One LIST of the repository (paginated by the store), a GET of the
// newest manifest, and a GET of the record if there is one. Only when some
// pack is unnamed by the newest manifest are the other kept manifests read,
// newest first, until every such pack is found named or they run out. Then
// a HEAD for the next manifest, up to three HEADs and three DELETEs for each
// pack deleted, a PUT (or DELETE) of the record when it changed, and a DELETE
// for each manifest deleted.
//
// It resolves with
//
//   { manifestsDeleted, packsMarked, packsDeleted, packsSpared, pending,
//     bytesFreed, requests: { lists, gets, heads, puts, deletes } }
//
// where `pending` is how many packs the record holds after the run, and
// `packsSpared` how many marked ones were dropped because they were named or
// written again. It throws on any failure of the store, leaving what it had
// not yet done to the next run; every step is safe to repeat.
const manifest = require("./manifest");
const { NotFoundError, CorruptError } = require("./errors");
const { PACK_NAME, SWEEP_KEY, manifestKey, manifestSeq, packFile } = require("./layout");

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const DEFAULTS = { grace: DAY, keepManifests: 20, recoveryWindow: 7 * DAY };

// A grace shorter than this could catch a push between its uploads and its
// swap, so it is refused
const MIN_GRACE = HOUR;

// A manifest swap refuses a base read more than manifest.MAX_BASE_AGE (a day)
// ago, so the seq a writer creates was never one deleted here as long as only
// manifests older than that are deleted. Twice it leaves a day for the host's
// and the store's clocks to disagree.
const MIN_RECOVERY_WINDOW = 2 * manifest.MAX_BASE_AGE;

const EXTS = ["pack", "idx", "rev"];

// The record is small: a few dozen bytes for each marked pack
const MAX_RECORD_BYTES = 16 * 1024 * 1024;

const RECORD_VERSION = 1;

// Two last-modified times are the same if they are in the same second: S3
// gives a LIST's to the millisecond and a HEAD's to the second
const sameTime = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.floor(a / 1000) === Math.floor(b / 1000);

// The store, counting what is asked of it
function counting(store) {
  const requests = { lists: 0, gets: 0, heads: 0, puts: 0, deletes: 0 };
  return {
    requests,
    list: (prefix) => (requests.lists++, store.list(prefix)),
    get: (key, options) => (requests.gets++, store.get(key, options)),
    head: (key) => (requests.heads++, store.head(key)),
    put: (key, body) => (requests.puts++, store.put(key, body)),
    delete: (key) => (requests.deletes++, store.delete(key)),
  };
}

async function loadManifest(s, seq) {
  const m = manifest.parse(await s.get(manifestKey(seq), { maxBytes: manifest.MAX_BYTES }));
  if (m.seq !== seq) throw new CorruptError(manifestKey(seq) + " says it is seq " + m.seq);
  return m;
}

// The record's marks by pack name, { at, keys: { ext: lastModified } }. A
// record that is missing or cannot be read is empty: that only delays.
async function readRecord(s) {
  let bytes;
  try {
    bytes = await s.get(SWEEP_KEY, { maxBytes: MAX_RECORD_BYTES });
  } catch (err) {
    if (err instanceof NotFoundError) return new Map();
    throw err;
  }

  const marks = new Map();
  try {
    const record = JSON.parse(bytes.toString("utf8"));
    if (!record || record.version !== RECORD_VERSION || !record.marked || typeof record.marked !== "object") return marks;
    for (const [name, mark] of Object.entries(record.marked)) {
      if (!PACK_NAME.test(name) || !mark || !Number.isSafeInteger(mark.at) || !mark.keys || typeof mark.keys !== "object") continue;
      const keys = {};
      for (const ext of EXTS) if (Number.isSafeInteger(mark.keys[ext])) keys[ext] = mark.keys[ext];
      if (Object.keys(keys).length) marks.set(name, { at: mark.at, keys });
    }
  } catch (err) {}
  return marks;
}

function serializeRecord(marks) {
  const marked = {};
  for (const name of [...marks.keys()].sort()) marked[name] = marks.get(name);
  return Buffer.from(JSON.stringify({ version: RECORD_VERSION, marked }, null, 2) + "\n");
}

// Deletes the files of the pack `name`, marked as `mark`, if each is as it was
// when marked. `newest` is the newest manifest, read just before: a pack it
// names is never deleted, and asking to is a bug, so it throws. Resolves with
// { deleted, spared, bytes }: spared if a file was written since the mark,
// neither if every file was already gone (another sweep, say).
async function deleteMarked(s, { name, mark, newest }) {
  const keys = EXTS.map((ext) => ({ ext, key: "packs/" + name + "." + ext }));
  const found = await Promise.all(keys.map(({ key }) => s.head(key)));

  const present = [];
  for (let i = 0; i < keys.length; i++) {
    if (!found[i]) continue;
    // Written since the mark, or not there when it was: spared
    if (!sameTime(found[i].lastModified, mark.keys[keys[i].ext])) return { deleted: false, spared: true, bytes: 0 };
    present.push({ key: keys[i].key, size: found[i].size });
  }
  if (!present.length) return { deleted: false, spared: false, bytes: 0 };

  if (manifest.packsNamed(newest).includes(name)) {
    throw Object.assign(new Error("The sweep was about to delete " + name + ", which the newest manifest (seq " + newest.seq + ") names"), {
      code: "SWEEP_REFERENCED",
    });
  }

  // Every DELETE has settled before this does, so a failure leaves no request
  // in flight; the next run finds what is left still as it was marked
  const settled = await Promise.allSettled(present.map(({ key }) => s.delete(key)));
  const failed = settled.find((result) => result.status === "rejected");
  if (failed) throw failed.reason;
  return { deleted: true, spared: false, bytes: present.reduce((sum, { size }) => sum + size, 0) };
}

async function sweep({ store, now = Date.now(), grace = DEFAULTS.grace, keepManifests = DEFAULTS.keepManifests, recoveryWindow = DEFAULTS.recoveryWindow }) {
  if (!Number.isSafeInteger(keepManifests) || keepManifests < 1) throw new Error("keepManifests must be a whole number, at least 1");
  if (!(grace >= MIN_GRACE)) throw new Error("grace must be at least " + MIN_GRACE + " ms");
  if (!(recoveryWindow >= MIN_RECOVERY_WINDOW)) throw new Error("recoveryWindow must be at least " + MIN_RECOVERY_WINDOW + " ms");

  const s = counting(store);
  const stats = { manifestsDeleted: 0, packsMarked: 0, packsDeleted: 0, packsSpared: 0, pending: 0, bytesFreed: 0, requests: s.requests };

  // ---- What there is: one listing ------------------------------------

  const manifests = new Map(); // seq -> { key, size, lastModified }
  const packs = new Map(); // name -> { ext: { size, lastModified } }
  let recordListed = false;
  // A loop, not Math.max(...): a listing can be longer than a call's arguments
  let listedNewest = 0;
  for await (const item of s.list("")) {
    const seq = manifestSeq(item.key);
    if (seq !== null) {
      manifests.set(seq, item);
      if (seq > listedNewest) listedNewest = seq;
      continue;
    }
    const file = packFile(item.key);
    if (file) {
      if (!packs.has(file.name)) packs.set(file.name, {});
      packs.get(file.name)[file.ext] = item;
      continue;
    }
    if (item.key === SWEEP_KEY) recordListed = true;
    // Anything else is not the sweep's to touch
  }

  // Only ever the oldest: the run from the lowest seq up to the first manifest
  // that is kept. Manifests are written in order, so that is every one old
  // enough, except after a rewrite's purge, which writes over the manifests
  // below its own after creating it (see rewrite.js). Deleting in order is
  // what keeps a stale writer's create out of a hole (manifest.swap).
  const doomed = [];
  for (const seq of [...manifests.keys()].sort((a, b) => a - b)) {
    const item = manifests.get(seq);
    if (!(seq <= listedNewest - keepManifests && Number.isFinite(item.lastModified) && item.lastModified < now - recoveryWindow)) break;
    doomed.push(seq);
  }
  const doomedSet = new Set(doomed);
  const kept = [...manifests.keys()].filter((seq) => !doomedSet.has(seq)).sort((a, b) => b - a);

  // ---- What the kept manifests name ----------------------------------

  let newest = listedNewest ? await loadManifest(s, listedNewest) : manifest.empty();
  let newestSeq = listedNewest;
  const named = new Set(manifest.packsNamed(newest));

  const marks = recordListed ? await readRecord(s) : new Map();
  // Marks of packs no longer listed are dropped below, whatever names them
  const unnamed = () => [...packs.keys()].filter((name) => !named.has(name));

  // The other kept manifests are read only while some pack is not yet known
  // to be named. One deleted under us by another sweep is skipped: that
  // sweep found it old enough to go, and its packs are only marked.
  for (const seq of kept) {
    if (!unnamed().length) break;
    if (seq === listedNewest) continue;
    let m;
    try {
      m = await loadManifest(s, seq);
    } catch (err) {
      if (err instanceof NotFoundError) continue;
      throw err;
    }
    for (const name of manifest.packsNamed(m)) named.add(name);
  }

  // A pack dropped from the record this run is not marked again until the
  // next: what the listing says of it may be older than what a HEAD found
  let changed = false;
  const dropped = new Set();
  const drop = (name) => {
    dropped.add(name);
    if (marks.delete(name)) changed = true;
  };

  // Reads any manifest newer than the newest seen so far, so a pack swapped
  // in since the listing counts as named
  async function readForward() {
    while (await s.head(manifestKey(newestSeq + 1))) {
      newestSeq++;
      newest = await loadManifest(s, newestSeq);
      for (const name of manifest.packsNamed(newest)) named.add(name);
    }
  }

  // ---- Phase 2: delete what was marked a grace ago -------------------

  for (const [name, mark] of [...marks]) {
    if (named.has(name) || !packs.has(name)) {
      // Named again, or already gone
      if (named.has(name)) stats.packsSpared++;
      drop(name);
      continue;
    }

    const listed = packs.get(name);
    const asMarked = Object.keys(listed).every((ext) => sameTime(listed[ext].lastModified, mark.keys[ext]));
    if (!asMarked) {
      // Written since it was marked; marked afresh once it is old again
      stats.packsSpared++;
      drop(name);
      continue;
    }

    // `now` and the mark are this host's clock, so this wait does not depend
    // on how far it is from the store's (which stamps lastModified)
    if (now - mark.at < grace) continue;

    // Any manifest swapped in since the listing, or since the last pack was
    // deleted: a HEAD when there is none, so the check is fresh for each
    await readForward();
    if (named.has(name)) {
      stats.packsSpared++;
      drop(name);
      continue;
    }

    const { deleted, spared, bytes } = await deleteMarked(s, { name, mark, newest });
    drop(name);
    if (deleted) {
      stats.packsDeleted++;
      stats.bytesFreed += bytes;
    }
    if (spared) stats.packsSpared++;
    else packs.delete(name);
  }

  // ---- Phase 1: mark what is unnamed and old -------------------------

  for (const [name, files] of packs) {
    if (named.has(name) || marks.has(name) || dropped.has(name)) continue;
    const times = Object.values(files).map((file) => file.lastModified);
    if (!times.every((time) => Number.isFinite(time) && time <= now - grace)) continue;

    const keys = {};
    for (const [ext, file] of Object.entries(files)) keys[ext] = file.lastModified;
    marks.set(name, { at: now, keys });
    stats.packsMarked++;
    changed = true;
  }

  stats.pending = marks.size;
  if (changed) {
    if (marks.size) await s.put(SWEEP_KEY, serializeRecord(marks));
    else await s.delete(SWEEP_KEY);
  } else if (!marks.size && recordListed) {
    // An empty or unreadable record
    await s.delete(SWEEP_KEY);
  }

  // ---- Old manifests -------------------------------------------------

  for (const seq of doomed) {
    await s.delete(manifestKey(seq));
    stats.manifestsDeleted++;
    stats.bytesFreed += manifests.get(seq).size;
  }

  return stats;
}

module.exports = sweep;
module.exports.DEFAULTS = DEFAULTS;
module.exports.MIN_GRACE = MIN_GRACE;
module.exports.MIN_RECOVERY_WINDOW = MIN_RECOVERY_WINDOW;
module.exports.deleteMarked = (store, options) => deleteMarked(counting(store), options);
