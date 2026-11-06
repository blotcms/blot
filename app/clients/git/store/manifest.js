// The manifest: the small document which says what a repository is.
// Everything else in the bucket is immutable packs. Every push writes a new
// manifest, after the packs it names are uploaded, as its own object
// (manifests/<seq>.json) which is never overwritten; a repository's state is
// whatever its newest manifest says.
//
//   {
//     "version": 1,
//     "seq": 7,                      changes by one with every swap
//     "writer": "<32 hex>",          a random nonce, new for every manifest
//                                    advance() makes (empty: none, at seq 0)
//     "epoch": "<16 hex>",           set by a rewrite (rewrite.js), carried
//                                    unchanged by every other writer. Optional:
//                                    absent reads as "". Objects are only ever
//                                    lost to a repository by a rewrite, so the
//                                    cache of objects by ID is keyed by it.
//     "head": "refs/heads/master",   the branch HEAD points at, or null
//     "refs": { "refs/heads/master": "<oid>", ... },
//     "packs": [                     the live packs, oldest first
//       { "name": "pack-<sha1>", "size": 123, "idxSize": 45, "objects": 9, "seq": 7 }
//     ],                             (seq: the swap which added the pack)
//     "snapshots": [ { "seq": 7, "refs": { ... } } ],
//                                    the refs as they were after each push
//     "history": null | { "name", "size", "idxSize", "objects", "through": 7 }
//                                    the pack holding the history up to a swap
//     "historyPieces": [             a pack of just the commits of each push
//       { "name", "size", "idxSize", "objects", "seq": 8 }
//     ]                              since then, oldest first. Appended by
//                                    pushes, so no push rebuilds the history
//                                    pack; compaction merges them into it.
//                                    Optional when read: absent means none.
//     "peeled": { "<tag oid>": "<oid>" }
//                                    for each annotated tag that a ref (now or
//                                    in a snapshot) points at, the object it
//                                    finally points at, which is what the
//                                    advertisement's "^{}" lines carry. Optional
//                                    when read: a manifest without it has never
//                                    recorded one.
//   }
//
// What makes a swap safe is the conditional create of manifests/<seq + 1>.json
// (the store's putIfAbsent): exactly one writer can create a given number, so
// of two pushes built on the same manifest one fails, however long either has
// stalled and whatever the lock did. The host's lock is not what makes it safe.
// swap() still takes it, because it keeps two pushes from the same base from
// creating the same manifest at once, but a swap which lost the lock, or never
// had it, is stopped all the same by the create.
//
// A create which lands but loses its response (or whose retry, by the SDK or
// by us, finds the key taken) looks like a lost race. So swap() does not guess:
// when the create says "already exists", or fails in a way which may have
// applied it, it reads the manifest at that seq. If it carries this swap's
// nonce, the swap landed; if another's, it was lost; if the read fails too,
// the outcome is unknown and swap() says so (OutcomeUnknownError).
//
// Finding the newest manifest costs no LIST in the usual case: manifests/latest.json
// holds { "seq": N }, written after each swap and overwritten each time. It is
// only a hint, and nothing trusts it: read() starts at the seq it names, looks
// forward for a later manifest, and falls back to LISTing manifests/ if the
// hint is missing, damaged or names something which doesn't exist.
//
// Old manifests are not deleted here: sweep.js does that, keeping the newest
// ones and any written recently. Removing a whole repository (remove.js)
// leaves its newest number taken by a tombstone, so the numbering never starts
// again at 1 under a process that still holds a manifest of the old history. Snapshots are trimmed from the old end by
// compacted() (see trimSnapshots), never by a push.
const crypto = require("crypto");
const {
  CorruptError,
  NotFoundError,
  TooLargeError,
  StaleManifestError,
  ManifestTooLargeError,
  OutcomeUnknownError,
  StoreError,
} = require("./errors");
const { MANIFEST_PREFIX, LATEST_KEY, PACK_NAME, manifestKey, manifestSeq, packKey, idxKey } = require("./layout");

const VERSION = 1;

// A manifest is small; this is only a guard against reading something else
const MAX_BYTES = 64 * 1024 * 1024;

// The hint is a few bytes; this is only a guard against reading something else
const MAX_HINT_BYTES = 1024;

// How many manifests past the hint read() will look for before it gives up on
// the hint as stale and LISTs instead
const WALK_LIMIT = 8;

// How long a writer may hold a manifest from read() as the base of a swap.
// The sweep deletes old manifests, which reopens their numbers; this is what
// stops a writer that stalled from creating a manifest in such a hole (see
// swap() below). sweep.js requires its recovery window to be well above it.
const MAX_BASE_AGE = 24 * 60 * 60 * 1000;

// For each manifest read() returned (by the object itself), when the store
// last showed it to be the newest, by this process's clock. Never part of the
// manifest's bytes. swap() times a base by it.
const readAt = new WeakMap();

// A manifest with a given number never changes, so its bytes can be kept, by
// store, with when the store last confirmed it (`confirmed`, the start of the
// read() that fetched or checked it). Only which number is the newest is ever
// asked of the store.
const KEPT = 8;
const kept = new WeakMap();

// A kept manifest the store has not confirmed for this long is checked again
// (a HEAD) before read() returns it: the sweep may have deleted it since. Half
// of MAX_BASE_AGE, so a base is never older than a day and a half by the
// store's last word on it (see swap()).
const RECONFIRM_AFTER = MAX_BASE_AGE / 2;

// The hint as this process last fetched it, by store: { etag, seq }, seq
// being what it names (null if it names nothing usable). read() asks for it
// again with If-None-Match, so while it is unchanged the store answers 304
// and sends no body.
const hints = new WeakMap();

// By store, the newest manifest the store last showed to be the newest, and
// when: { seq, at }, `at` being the start of the read whose HEAD found seq + 1
// missing (or the LIST that found seq), or when a swap of seq landed.
const newest = new WeakMap();

// How long a read for serving (read(store, { serving: true }): an
// advertisement, a clone or a fetch, never the base of a write) trusts an
// unchanged hint without the HEAD for the next seq. The hint is written after
// a swap, best-effort, and concurrent swaps can land their hints out of
// order, so it can lag; within this long of the store's own word that the
// kept manifest was the newest, a 304 naming it is taken as enough. So a
// serving read may give refs at most this far behind a swap whose hint was
// lost or overtaken, and a writer, which always asks, never builds on one.
const TRUST_UNCHANGED_HINT = 5 * 1000;

const OID = /^[0-9a-f]{40}$/;
const WRITER = /^[0-9a-zA-Z_-]{1,64}$/;

function empty() {
  return { version: VERSION, seq: 0, writer: "", head: null, refs: {}, packs: [], snapshots: [], history: null, historyPieces: [] };
}

function fail(message) {
  throw new CorruptError("Invalid manifest: " + message);
}

function checkCount(value, what) {
  if (!Number.isSafeInteger(value) || value < 0) fail(what + " must be a whole number");
}

function checkRefs(refs, what) {
  if (!refs || typeof refs !== "object" || Array.isArray(refs)) fail(what + " must be an object");

  for (const [name, oid] of Object.entries(refs)) {
    // eslint-disable-next-line no-control-regex
    if (!/^refs\/[^\s\x00-\x1f\x7f~^:?*[\\]+$/.test(name) || name.includes("..")) {
      fail(what + " has an invalid ref name " + JSON.stringify(name));
    }
    if (!OID.test(oid)) fail(what + " has an invalid object ID for " + name);
  }
}

function checkPack(pack, what, seq) {
  if (!pack || typeof pack !== "object") fail(what + " must be an object");
  if (!PACK_NAME.test(pack.name)) fail(what + " has an invalid pack name");
  for (const field of ["size", "idxSize", "objects"]) checkCount(pack[field], what + "." + field);
  if (pack.size < 32) fail(what + ".size is too small to be a pack");
}

// Throws CorruptError unless `m` is a manifest this version understands
function validate(m) {
  if (!m || typeof m !== "object") fail("not an object");
  if (m.version !== VERSION) fail("version " + m.version + " is not supported (this reads version " + VERSION + ")");
  checkCount(m.seq, "seq");
  if (typeof m.writer !== "string") fail("writer must be a string");
  if (m.seq > 0 ? !WRITER.test(m.writer) : m.writer !== "") fail("writer must be a nonce (and empty only at seq 0)");

  if (m.epoch !== undefined && (typeof m.epoch !== "string" || !WRITER.test(m.epoch))) fail("epoch must be a nonce when it is there");

  if (m.head !== null && !(typeof m.head === "string" && m.head.startsWith("refs/"))) fail("head must be a ref name or null");
  checkRefs(m.refs, "refs");

  if (!Array.isArray(m.packs)) fail("packs must be a list");
  const names = new Set();
  for (const pack of m.packs) {
    checkPack(pack, "packs[]");
    checkCount(pack.seq, "packs[].seq");
    if (pack.seq > m.seq) fail("a pack is newer than the manifest");
    if (names.has(pack.name)) fail("pack " + pack.name + " is listed twice");
    names.add(pack.name);
  }

  if (!Array.isArray(m.snapshots)) fail("snapshots must be a list");
  let previous = 0;
  for (const snapshot of m.snapshots) {
    checkCount(snapshot.seq, "snapshots[].seq");
    if (snapshot.seq <= previous || snapshot.seq > m.seq) fail("snapshots are out of order");
    previous = snapshot.seq;
    checkRefs(snapshot.refs, "snapshots[].refs");
  }

  if (m.history !== null) {
    checkPack(m.history, "history");
    checkCount(m.history.through, "history.through");
    if (m.history.through > m.seq) fail("history is newer than the manifest");
  }

  if (m.peeled !== undefined) {
    if (!m.peeled || typeof m.peeled !== "object" || Array.isArray(m.peeled)) fail("peeled must be an object");
    for (const [tag, target] of Object.entries(m.peeled)) {
      if (!OID.test(tag) || !OID.test(target)) fail("peeled must map object IDs to object IDs");
    }
  }

  if (m.historyPieces !== undefined) {
    if (!Array.isArray(m.historyPieces)) fail("historyPieces must be a list");
    for (const piece of m.historyPieces) {
      checkPack(piece, "historyPieces[]");
      checkCount(piece.seq, "historyPieces[].seq");
      if (piece.seq > m.seq) fail("a history piece is newer than the manifest");
    }
  }

  return m;
}

function sortRefs(refs) {
  return Object.fromEntries(Object.keys(refs).sort().map((name) => [name, refs[name]]));
}

// The manifest as bytes: stable, so the same manifest is the same bytes
function serialize(m) {
  validate(m);
  const document = {
    ...m,
    refs: sortRefs(m.refs),
    snapshots: m.snapshots.map((s) => ({ seq: s.seq, refs: sortRefs(s.refs) })),
  };
  if (m.peeled) document.peeled = sortRefs(m.peeled);
  return Buffer.from(JSON.stringify(document, null, 2) + "\n");
}

function parse(buffer) {
  let m;
  try {
    m = JSON.parse(buffer.toString("utf8"));
  } catch (err) {
    fail("not JSON");
  }
  return validate(m);
}

function remember(store, seq, bytes, confirmed) {
  let bySeq = kept.get(store);
  if (!bySeq) kept.set(store, (bySeq = new Map()));
  bySeq.delete(seq);
  bySeq.set(seq, { bytes, confirmed });
  if (bySeq.size > KEPT) bySeq.delete(bySeq.keys().next().value);
}

function forget(store, seq) {
  const bySeq = kept.get(store);
  if (bySeq) bySeq.delete(seq);
  const last = newest.get(store);
  if (last && last.seq === seq) newest.delete(store);
}

// The store showed `seq` to be the newest at `at` (or later)
function markNewest(store, seq, at) {
  const last = newest.get(store);
  if (last && (last.seq > seq || (last.seq === seq && last.at >= at))) return;
  newest.set(store, { seq, at });
}

// The manifest with this number, and when the store last confirmed it is
// there: { m, confirmed }. Bytes kept from an earlier read are used if the
// store confirmed them within RECONFIRM_AFTER, and otherwise kept after a HEAD
// says the manifest is still there. `now` is the time to record for a
// confirmation made here. Throws NotFoundError if there isn't one.
async function load(store, seq, now) {
  const bySeq = kept.get(store);
  let entry = bySeq && bySeq.get(seq);
  if (entry && now - entry.confirmed > RECONFIRM_AFTER) {
    if (await store.head(manifestKey(seq))) {
      entry.confirmed = now;
    } else {
      forget(store, seq);
      throw new NotFoundError("No such key: " + manifestKey(seq));
    }
  }
  if (!entry) {
    const bytes = await store.get(manifestKey(seq), { maxBytes: MAX_BYTES });
    remember(store, seq, bytes, now);
    entry = { bytes, confirmed: now };
  }
  const m = parse(entry.bytes);
  if (m.seq !== seq) fail(manifestKey(seq) + " says it is seq " + m.seq);
  return { m, confirmed: entry.confirmed };
}

// The seq a hint's bytes name, or null if they aren't one
function hintSeq(bytes) {
  try {
    const hint = JSON.parse(bytes.toString("utf8"));
    return hint && Number.isSafeInteger(hint.seq) && hint.seq >= 1 ? hint.seq : null;
  } catch (err) {
    return null;
  }
}

// The seq latest.json names (null if it is missing or isn't a seq), as
// { seq, unchanged }: a conditional GET, so `unchanged` is true when the store
// answered 304 for the ETag this process last fetched it with, and seq is
// then what it named then. A store which ignores the condition answers with
// the bytes, which is never wrong.
async function readHint(store) {
  const known = hints.get(store);
  let answer;
  try {
    answer = await store.get(LATEST_KEY, { maxBytes: MAX_HINT_BYTES, ifNoneMatch: known ? known.etag : null });
  } catch (err) {
    if (err instanceof NotFoundError || err instanceof TooLargeError) {
      hints.delete(store);
      return { seq: null, unchanged: false };
    }
    throw err;
  }
  if (answer && answer.notModified && known) return { seq: known.seq, unchanged: true };

  const bytes = Buffer.isBuffer(answer) ? answer : answer && answer.bytes;
  const seq = bytes ? hintSeq(bytes) : null;
  if (answer && answer.etag && bytes) hints.set(store, { etag: answer.etag, seq });
  else hints.delete(store);
  return { seq, unchanged: false };
}

// The highest seq whose bytes this process keeps for `store`, or null
function newestKept(store) {
  const bySeq = kept.get(store);
  if (!bySeq || !bySeq.size) return null;
  return Math.max(...bySeq.keys());
}

// The newest manifest found by starting at the hint and looking forward, as
// { seq, loading }, or null if there is no usable hint or it is too far
// behind. `loading`, when there is one, is load() of that seq already under
// way (settled as { found } or { err }).
//
// Two things run alongside the hint's GET, so the usual read waits on one
// round trip, or two:
//
// - With bytes kept for seq K (the manifest this process last read or
//   swapped in), a HEAD for K + 1. If it is missing and the hint is not past
//   K, K is the newest, as surely as when the hint names K itself: the same
//   HEAD is what read() would have asked next. (load() still checks K is
//   there if the store has not confirmed it for a while.)
// - Otherwise the GET of the manifest the hint names starts with the HEAD
//   for the one after it, rather than after it.
//
// The hint's GET is conditional (see readHint). A read for serving (`serving`)
// whose kept K the store showed to be the newest within TRUST_UNCHANGED_HINT,
// and whose last fetch of the hint named K, sends that GET alone: a 304 means
// K, with no HEAD (the answer then has `trustedAt`, when the store last showed
// K to be the newest). If the hint changed, it carries on as any read does,
// with the HEAD after the GET instead of beside it. Every other read sends
// the HEAD beside the GET as before, a writer's included, so a hint that lags
// is caught as before.
async function walkFromHint(store, now, serving) {
  const keptSeq = newestKept(store);
  const last = newest.get(store);
  const known = hints.get(store);
  const trusting =
    serving &&
    keptSeq !== null &&
    last &&
    last.seq === keptSeq &&
    now >= last.at &&
    now - last.at <= TRUST_UNCHANGED_HINT &&
    known &&
    known.seq === keptSeq;

  let hint;
  let afterKept;
  if (trusting) {
    hint = await readHint(store);
    if (hint.unchanged && hint.seq === keptSeq) return { seq: keptSeq, trustedAt: last.at };
  } else {
    [hint, afterKept] = await Promise.all([readHint(store), keptSeq === null ? null : store.head(manifestKey(keptSeq + 1))]);
  }

  if (hint.seq === null) return null;
  if (keptSeq !== null && hint.seq <= keptSeq) {
    if (afterKept === undefined) afterKept = await store.head(manifestKey(keptSeq + 1));
    if (!afterKept) return { seq: keptSeq };
  }

  let seq = hint.seq;
  for (let steps = 0; steps < WALK_LIMIT; steps++) {
    const loading =
      steps === 0
        ? load(store, seq, now).then(
            (found) => ({ found }),
            (err) => ({ err })
          )
        : null;
    if (!(await store.head(manifestKey(seq + 1)))) return { seq, loading };
    seq++;
  }
  return null;
}

// The seq of the newest manifest, by listing them; 0 if there are none
async function listNewest(store) {
  let newest = 0;
  for await (const { key } of store.list(MANIFEST_PREFIX)) {
    const seq = manifestSeq(key);
    if (seq !== null && seq > newest) newest = seq;
  }
  return newest;
}

// The repository's newest manifest, read from the store (never from the cache
// of packs: only the store knows which manifest is the newest). A repository
// nothing has been pushed to has none, which reads as an empty one with seq 0.
//
// In the usual case that is a GET of the hint, a HEAD for the manifest after
// the one it names (which isn't there), and a GET of the manifest, unless this
// process already holds its bytes. The hint can only make read() look in the
// wrong place, never return the wrong manifest: whatever it names, read() looks
// forward for newer ones, and if what it names isn't there, LISTs instead.
//
// The manifest returned is stamped with when the store last showed it to be
// the newest (by `clock`, Date.now unless given), which is the time swap()
// goes by when it is a base: the start of this read when its bytes were
// fetched or checked here, or the start of the read that did so when they
// were kept, at most RECONFIRM_AFTER ago. Kept bytes past that are checked
// with a HEAD, and a manifest gone since (the sweep deleted it, and the hint
// still names it) is a miss, and the LIST finds the newest.
//
// `serving: true` is for a read whose manifest is only served (a ref
// advertisement, a clone or a fetch) and never built on: it may skip the HEAD
// for the next seq while the hint is unchanged, for TRUST_UNCHANGED_HINT after
// the store last showed the kept manifest to be the newest (see walkFromHint),
// so the usual warm read for serving is one conditional GET answered 304. Its
// stamp is the earlier of that time and the kept bytes' confirmation, so a
// writer handed one anyway is still timed from the store's own word.
async function read(store, { clock = Date.now, serving = false } = {}) {
  const now = clock();
  const stamp = ({ m, confirmed }, shown = now) => {
    readAt.set(m, Math.min(confirmed, shown));
    return m;
  };
  const shown = (seq) => markNewest(store, seq, now);
  const hinted = await walkFromHint(store, now, serving);
  if (hinted !== null) {
    try {
      if (hinted.trustedAt !== undefined) return stamp(await load(store, hinted.seq, now), hinted.trustedAt);
      let found;
      if (hinted.loading) {
        const settled = await hinted.loading;
        if (settled.err) throw settled.err;
        found = settled.found;
      } else {
        found = await load(store, hinted.seq, now);
      }
      shown(hinted.seq);
      return stamp(found);
    } catch (err) {
      if (!(err instanceof NotFoundError)) throw err;
    }
  }

  const seq = await listNewest(store);
  if (seq === 0) return stamp({ m: empty(), confirmed: now });
  const found = await load(store, seq, now);
  shown(seq);
  return stamp(found);
}

// Throws StaleManifestError if the store last showed `base` to be the newest
// (a read, or the swap that made it) more than MAX_BASE_AGE ago. A base read() did not return (built by hand, or
// a copy) has no time and passes; every writer here swaps the very object
// read() gave it.
function isFresh(base, clock = Date.now) {
  const at = readAt.get(base);
  return at === undefined || clock() - at <= MAX_BASE_AGE;
}

function assertFresh(base, clock) {
  if (!isFresh(base, clock)) {
    throw new StaleManifestError("The manifest seq " + base.seq + " was read too long ago to build on; read it again");
  }
}

// The manifest which follows `base` after a push: `refs` are all the refs now,
// `packs` the packs the push added (one the manifest already lists is moved to
// the end with this push's seq: its objects were made reachable again by this
// push, and a pack's seq is the push that last made its objects needed, which
// fetch relies on) and `historyPieces` the history pieces it
// added (all already uploaded), `head` and `history` are changed only if
// given. The ref snapshot for the push is recorded. `peeled` adds the peeled
// targets of annotated tags the push put in refs; the manifest keeps the ones
// for tags the refs and snapshots still name, and no others. A manifest which
// has refs but no `peeled` was written before the field existed, so which of
// its refs are annotated tags is not known; it stays without the field (and
// fetch treats it with care) rather than claim that none are.
function advance(base, { refs, packs = [], historyPieces = [], head = base.head, history = base.history, peeled = {} }) {
  const seq = base.seq + 1;
  const snapshots = [...base.snapshots, { seq, refs: { ...refs } }];
  const moved = new Set(packs.map((pack) => pack.name));
  const records = base.peeled !== undefined || base.snapshots.length === 0;
  return {
    ...base,
    seq,
    writer: crypto.randomBytes(16).toString("hex"),
    head,
    refs: { ...refs },
    packs: [...base.packs.filter((pack) => !moved.has(pack.name)), ...packs.map((pack) => ({ ...pack, seq }))],
    snapshots,
    ...(records ? { peeled: keepPeeled({ ...base.peeled, ...peeled }, snapshots) } : {}),
    history,
    historyPieces: [...(base.historyPieces || []), ...historyPieces.map((piece) => ({ ...piece, seq }))],
  };
}

// The manifest which follows `base` after a compaction: the packs named in
// `remove` are replaced by `add` (one pack holding every object they held), and
// the history pieces named in `removePieces` by `history` (a history pack
// holding every commit of the old one and of those pieces). Refs, head,
// snapshots and peeled are unchanged, and no snapshot is added: the refs did
// not change, so no client's place moved.
//
// The merged pack takes the largest seq any of the removed packs has in
// `base`. A pack's seq is the last swap which made any of its objects needed
// (fetch sends the packs above a client's place by it), and the merged pack
// holds the objects of every removed pack, so it is the newest of theirs. It
// goes where that seq belongs in the list, which is ordered by seq, after the
// packs with the same seq: the reader and clone read the copy of an object in
// the pack latest in the list, and with every pack self-contained any copy is
// right, so keeping the list in seq order is all that matters.
//
// The snapshots are trimmed to `limits` (SNAPSHOT_LIMITS unless given; see
// trimSnapshots), from the old end, and `peeled` keeps only the tags the
// snapshots left still name. The newest snapshot is the refs as they are, so
// what the advertisement needs is always kept.
//
// Throws StaleManifestError if `base` no longer lists a pack in `remove` or a
// piece in `removePieces`: someone else compacted them away first.
function compacted(base, { remove = [], add = null, history, removePieces = [], limits = {} }) {
  const listed = new Map(base.packs.map((pack) => [pack.name, pack]));
  const gone = remove.filter((name) => !listed.has(name));
  if (gone.length) throw new StaleManifestError("The manifest no longer lists " + gone.join(", "));
  if (remove.length && !add) throw new Error("A compaction which removes packs must add the pack they were merged into");

  const pieces = base.historyPieces || [];
  const pieceNames = new Set(pieces.map((piece) => piece.name));
  const goneByPiece = removePieces.filter((name) => !pieceNames.has(name));
  if (goneByPiece.length) throw new StaleManifestError("The manifest no longer lists the history pieces " + goneByPiece.join(", "));

  let packs = base.packs;
  if (add) {
    const removed = new Set(remove);
    // The merged pack can only already be listed if it is the very pack some
    // earlier push or compaction made of the same objects; it is listed once,
    // with the newer seq of the two
    const same = listed.get(add.name);
    const seq = Math.max(...remove.map((name) => listed.get(name).seq), same ? same.seq : 0);
    packs = base.packs.filter((pack) => !removed.has(pack.name) && pack.name !== add.name);
    let at = packs.length;
    while (at > 0 && packs[at - 1].seq > seq) at--;
    packs = [...packs.slice(0, at), { name: add.name, size: add.size, idxSize: add.idxSize, objects: add.objects, seq }, ...packs.slice(at)];
  }

  const dropped = new Set(removePieces);
  const snapshots = trimSnapshots(base.snapshots, limits);
  return {
    ...base,
    seq: base.seq + 1,
    writer: crypto.randomBytes(16).toString("hex"),
    packs,
    snapshots,
    ...(base.peeled !== undefined ? { peeled: keepPeeled(base.peeled, snapshots) } : {}),
    history: history === undefined ? base.history : history,
    historyPieces: pieces.filter((piece) => !dropped.has(piece.name)),
  };
}

// The epoch of manifest `m`: "" for one no rewrite has touched
function epochOf(m) {
  return (m && m.epoch) || "";
}

// A new epoch for a rewrite
function newEpoch() {
  return crypto.randomBytes(8).toString("hex");
}

// The manifest which follows `base` after a rewrite (rewrite.js): the same
// refs, head and peeled targets, and the objects they reach in one pack
// (`pack`, or null when there are no refs) with the new seq, the commits among
// them in one history pack (`history`, or null when no ref reaches a commit)
// and no history pieces. `peeled`, when given, replaces base's (the rewrite
// works it out from the objects); either way only the tags the snapshot names
// are kept.
//
// The snapshots are only the refs as they are now. An older one names commits
// the rewrite may have dropped, and fetch must never take a client's place
// from a snapshot whose objects are gone, so a client that does not have the
// current tips is sent everything, as after any history rewrite.
//
// `epoch` is new (newEpoch()): every cache of objects by ID is keyed by it, so
// nothing cached before the rewrite stands in for the packs after it.
function rewritten(base, { epoch, pack = null, history = null, peeled }) {
  if (typeof epoch !== "string" || !WRITER.test(epoch)) throw new Error("A rewrite needs a new epoch");
  if (epoch === epochOf(base)) throw new Error("A rewrite needs an epoch other than the one it replaces");
  const seq = base.seq + 1;
  const entry = (p) => ({ name: p.name, size: p.size, idxSize: p.idxSize, objects: p.objects });
  const snapshots = [{ seq, refs: { ...base.refs } }];
  const tags = peeled !== undefined ? peeled : base.peeled;
  return {
    version: VERSION,
    seq,
    writer: crypto.randomBytes(16).toString("hex"),
    epoch,
    head: base.head,
    refs: { ...base.refs },
    packs: pack ? [{ ...entry(pack), seq }] : [],
    snapshots,
    ...(tags !== undefined ? { peeled: keepPeeled(tags, snapshots) } : {}),
    history: history ? { ...entry(history), through: seq } : null,
    historyPieces: [],
  };
}

// The manifest which follows `base` when the repository is removed (remove.js):
// no refs, packs, snapshots or history, and a new epoch. It is a tombstone
// which keeps the numbering going: whatever is built later (an import) goes
// above it, never back at seq 1, where a process still holding an older
// manifest of the removed history could build on it.
function removed(base) {
  return {
    version: VERSION,
    seq: base.seq + 1,
    writer: crypto.randomBytes(16).toString("hex"),
    epoch: newEpoch(),
    head: null,
    refs: {},
    packs: [],
    snapshots: [],
    history: null,
    historyPieces: [],
  };
}

// Whether `m` holds nothing: the empty manifest (seq 0), or a removal's
// tombstone. An import goes into either, and a host treats both as no copy
// at all.
function isEmpty(m) {
  return !Object.keys(m.refs).length && !m.packs.length && !m.history && !(m.historyPieces || []).length;
}

// How many snapshots a manifest keeps, and how many bytes of them, once
// compaction trims it (see trimSnapshots). A snapshot is about 100 bytes for a
// blog with a ref or two, so 1000 of them is about 100 KB; the byte cap is for
// a repository with many refs, where each snapshot is large. At least `min`
// are kept whatever their size, so a client a few pushes behind still fetches
// only what it lacks.
const SNAPSHOT_LIMITS = { maxSnapshots: 1000, maxSnapshotBytes: 1024 * 1024, minSnapshots: 8 };

// The bytes a snapshot takes, as JSON without the manifest's indentation
function snapshotBytes(snapshot) {
  return Buffer.byteLength(JSON.stringify(snapshot));
}

// The newest of `snapshots` that fit the limits: at most maxSnapshots, then as
// many more dropped from the old end as it takes to bring them under
// maxSnapshotBytes, but never fewer than minSnapshots (nor than there are).
// Only the old end is ever trimmed. Fetch sends the packs above the newest
// snapshot a client provably has, so trimming old snapshots only lowers what a
// client far behind can prove, which makes it fetch everything (as a clone
// does); it never makes fetch send too little.
function trimSnapshots(snapshots, limits = {}) {
  const { maxSnapshots, maxSnapshotBytes, minSnapshots } = { ...SNAPSHOT_LIMITS, ...limits };
  let start = Math.max(0, snapshots.length - maxSnapshots);
  let bytes = 0;
  for (let i = start; i < snapshots.length; i++) bytes += snapshotBytes(snapshots[i]);
  while (bytes > maxSnapshotBytes && snapshots.length - start > Math.min(minSnapshots, maxSnapshots)) {
    bytes -= snapshotBytes(snapshots[start]);
    start++;
  }
  return start === 0 ? snapshots : snapshots.slice(start);
}

// The peeled targets of the tags some snapshot names. A snapshot is how long a
// tag can still be asked for, so it is how long its target is wanted.
function keepPeeled(peeled, snapshots) {
  const named = new Set();
  for (const snapshot of snapshots) for (const oid of Object.values(snapshot.refs)) named.add(oid);
  return Object.fromEntries(Object.entries(peeled).filter(([tag]) => named.has(tag)));
}

// The names of every pack a manifest needs kept: its packs, its history pack
// and its history pieces. Each is a .pack and .idx, and a .rev for most.
function packsNamed(m) {
  const names = m.packs.map((pack) => pack.name);
  if (m.history) names.push(m.history.name);
  for (const piece of m.historyPieces || []) names.push(piece.name);
  return names;
}

// Packs are uploaded before the manifest that names them. This checks it,
// rather than trusting every caller to have done it. A caller which has just
// seen its own uploads of a pack's .pack and .idx succeed can name the pack in
// `uploaded`, and its HEADs are skipped.
async function assertUploaded(store, base, next, uploaded) {
  const known = new Set(base.packs.map((pack) => pack.name));
  const added = next.packs.filter((pack) => !known.has(pack.name));
  const knownPieces = new Set((base.historyPieces || []).map((piece) => piece.name));
  added.push(...(next.historyPieces || []).filter((piece) => !knownPieces.has(piece.name)));
  if (next.history && !(base.history && base.history.name === next.history.name)) added.push(next.history);

  for (const pack of added) {
    if (uploaded.has(pack.name)) continue;
    for (const [key, size] of [[packKey(pack.name), pack.size], [idxKey(pack.name), pack.idxSize]]) {
      const found = await store.head(key);
      if (!found || found.size !== size) {
        throw new StaleManifestError("The manifest names " + key + " which is not uploaded (or is the wrong size)");
      }
    }
  }
}

// Whether a failed create may nevertheless have been applied. A StoreError
// is ours and says nothing was written; an HTTP answer in the 4xx range (other
// than a timeout) is the store refusing the request; anything else (a network
// error, a timeout, a 5xx, an error we can't classify) may have come after the
// write. Calling an outcome unknown when it wasn't only costs a read.
function outcomeIsUnknown(err) {
  if (err instanceof StoreError) return false;
  const status = err && err.$metadata && err.$metadata.httpStatusCode;
  if (status) return status >= 500 || status === 408;
  return true;
}

// Called when manifests/<next.seq>.json may be this swap's: reads it and says
// whether it is. `cause` is the error which made it doubtful, or null if the
// create answered "already exists". Resolves with the bytes found if they are
// this swap's own; throws StaleManifestError if they are another writer's,
// `cause` if there is no such manifest (the create did not land), and
// OutcomeUnknownError if the read can't say.
async function confirm(store, next, cause) {
  const unknown = (err) =>
    new OutcomeUnknownError("Could not tell whether the swap to seq " + next.seq + " happened: " + err.message, cause || err);

  let found;
  try {
    found = await store.get(manifestKey(next.seq), { maxBytes: MAX_BYTES });
  } catch (err) {
    if (!(err instanceof NotFoundError)) throw unknown(err);
    if (cause) throw cause;
    throw new StaleManifestError("The manifest moved on from seq " + (next.seq - 1));
  }

  let theirs;
  try {
    theirs = parse(found);
  } catch (err) {
    throw unknown(err);
  }

  if (theirs.seq !== next.seq || theirs.writer !== next.writer) {
    throw new StaleManifestError("The manifest moved on from seq " + (next.seq - 1));
  }
  return found;
}

// Replaces `base`, the manifest the caller built `next` from, with `next`.
//
// Creating manifests/<next.seq>.json is the commit: if it is already there
// someone swapped first, and the caller starts again from the new manifest.
// Throws StaleManifestError, writing nothing, if so, if next is not the
// manifest after base, or if a pack it names isn't uploaded.
//
// A create which answers "already exists", or fails in a way which may have
// applied it, is checked by reading the manifest back: if it carries `next`'s
// writer nonce the swap landed (a response was lost, or a retry found its own
// earlier attempt) and swap resolves as a success, so calling swap again with
// the same `next` after an error is safe too. Throws OutcomeUnknownError if
// the read fails as well; the caller must then report neither success nor
// failure to its client.
//
// `lock(fn)` is the host's per-repository lock: it runs fn while holding the
// lock and resolves with fn's result. It need only be held for this call. It
// is not what makes the swap safe (a lock can expire under a process which
// has stalled); it only keeps pushes from the same base from creating the
// same manifest at once.
//
// `uploaded` (optional) lists the names of packs and history pieces whose
// .pack and .idx this caller has just uploaded, whose PUTs it saw succeed, at
// the sizes `next` names. Anything `next` adds and `uploaded` does not list
// is still checked with a HEAD for each file, so a caller which has not
// uploaded its packs itself gets the same guarantee as before.
//
// A base the store last showed to be the newest more than MAX_BASE_AGE ago
// (by `clock`, Date.now unless given; see read()) is refused with
// StaleManifestError, before any request and again just before the create,
// so the writer reads again through its usual stale path. That is what keeps
// the conditional create safe once the sweep deletes old manifests. When the
// store showed k to be the newest (k + 1 missing, k there), k + 1 had never
// existed: the sweep deletes in order, so it never deletes k + 1 while k is
// still there. So any k + 1 there is, or was and has been deleted, was written
// since then, which is at most MAX_BASE_AGE before the create. The sweep only
// deletes manifests older than its recovery window (at least two days), so the
// key this create targets was never one it deleted. Bytes kept in memory are
// what make "since then" more than this read: they count from the read that
// last fetched or checked them, which is never more than RECONFIRM_AFTER ago,
// so a kept manifest the sweep has since deleted is found gone, not built on.
async function swap({ store, lock, base, next, uploaded = [], clock = Date.now, waitForHint = true }) {
  if (typeof lock !== "function") throw new Error("swap needs the host's lock function");
  validate(base);
  validate(next);
  if (next.seq !== base.seq + 1) throw new StaleManifestError("The new manifest does not follow the one it was built on");
  assertFresh(base, clock);

  // A manifest is immutable, so one read() would refuse could never be fixed
  // and would leave the repository unreadable: it is never written
  const bytes = serialize(next);
  if (bytes.length > MAX_BYTES) {
    throw new ManifestTooLargeError("The manifest is " + bytes.length + " bytes; the most that can be read back is " + MAX_BYTES);
  }

  await assertUploaded(store, base, next, new Set(uploaded));

  return lock(async () => {
    // Nothing is looked at first: if the manifest after the base is already
    // there, the create below answers "already exists", and reading it back
    // says whether it is this very swap, landed on an earlier try, or another
    // writer's, which is a StaleManifestError.
    let landed = null;

    // Waiting for the lock and the HEADs above take time too
    assertFresh(base, clock);

    if (!landed) {
      let created;
      try {
        created = await store.putIfAbsent(manifestKey(next.seq), bytes);
      } catch (err) {
        if (!outcomeIsUnknown(err)) throw err;
        landed = await confirm(store, next, err);
      }
      if (created === false) landed = await confirm(store, next, null);
    }
    // next + 1 did not exist when this create landed, so `next` is as fresh a
    // base as one just read
    const landedAt = clock();
    remember(store, next.seq, landed || bytes, landedAt);
    markNewest(store, next.seq, landedAt);
    readAt.set(next, landedAt);

    // The swap has happened. The hint only saves the next reader some looking,
    // so a failure to write it is not a failure to swap: it is logged and the
    // swap resolves. It is waited for by default, so a client told its push
    // landed finds the new hint on its next request, and a serving read in
    // another process, which trusts an unchanged hint for a few seconds (see
    // read()), sees the push. A caller which passes `waitForHint: false` is
    // answered without waiting: until it lands, a writer starting from the
    // old hint looks one manifest further forward, and a serving read may give
    // the manifest before.
    const hint = store
      .put(LATEST_KEY, Buffer.from(JSON.stringify({ seq: next.seq }) + "\n"))
      .catch((err) => console.error("Git store: could not write the hint for seq " + next.seq, err));
    if (waitForHint) await hint;

    return next;
  });
}

module.exports = {
  VERSION,
  MAX_BYTES,
  MAX_BASE_AGE,
  TRUST_UNCHANGED_HINT,
  SNAPSHOT_LIMITS,
  empty,
  validate,
  parse,
  serialize,
  read,
  advance,
  compacted,
  rewritten,
  removed,
  isEmpty,
  epochOf,
  newEpoch,
  trimSnapshots,
  isFresh,
  snapshotBytes,
  packsNamed,
  swap,
};
