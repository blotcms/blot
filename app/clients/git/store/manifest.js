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
// swap() still takes it, because it stops two pushes from the same base doing
// wasted work and gives the loser its answer early, but a swap which lost the
// lock, or never had it, is stopped all the same by the create.
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
// Old manifests are not deleted here; that belongs with compaction.
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

// A manifest with a given number never changes, so its bytes can be kept for
// good, by store. Only which number is the newest is ever asked of the store.
const KEPT = 8;
const kept = new WeakMap();

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

function remember(store, seq, bytes) {
  let bySeq = kept.get(store);
  if (!bySeq) kept.set(store, (bySeq = new Map()));
  bySeq.delete(seq);
  bySeq.set(seq, bytes);
  if (bySeq.size > KEPT) bySeq.delete(bySeq.keys().next().value);
}

// The manifest with this number. Throws NotFoundError if there isn't one.
async function load(store, seq) {
  const bySeq = kept.get(store);
  let bytes = bySeq && bySeq.get(seq);
  if (!bytes) {
    bytes = await store.get(manifestKey(seq), { maxBytes: MAX_BYTES });
    remember(store, seq, bytes);
  }
  const m = parse(bytes);
  if (m.seq !== seq) fail(manifestKey(seq) + " says it is seq " + m.seq);
  return m;
}

// The seq latest.json names, or null if it is missing or isn't a seq
async function readHint(store) {
  let bytes;
  try {
    bytes = await store.get(LATEST_KEY, { maxBytes: MAX_HINT_BYTES });
  } catch (err) {
    if (err instanceof NotFoundError || err instanceof TooLargeError) return null;
    throw err;
  }
  try {
    const hint = JSON.parse(bytes.toString("utf8"));
    return hint && Number.isSafeInteger(hint.seq) && hint.seq >= 1 ? hint.seq : null;
  } catch (err) {
    return null;
  }
}

// The seq of the newest manifest found by starting at the hint and looking
// forward, or null if there is no usable hint or it is too far behind
async function walkFromHint(store) {
  let seq = await readHint(store);
  if (seq === null) return null;

  for (let steps = 0; steps < WALK_LIMIT; steps++) {
    if (!(await store.head(manifestKey(seq + 1)))) return seq;
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
async function read(store) {
  const hinted = await walkFromHint(store);
  if (hinted !== null) {
    try {
      return await load(store, hinted);
    } catch (err) {
      if (!(err instanceof NotFoundError)) throw err;
    }
  }

  const newest = await listNewest(store);
  return newest === 0 ? empty() : load(store, newest);
}

// The manifest which follows `base` after a push: `refs` are all the refs now,
// `packs` the packs the push added and `historyPieces` the history pieces it
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
  const records = base.peeled !== undefined || base.snapshots.length === 0;
  return {
    ...base,
    seq,
    writer: crypto.randomBytes(16).toString("hex"),
    head,
    refs: { ...refs },
    packs: [...base.packs, ...packs.map((pack) => ({ ...pack, seq }))],
    snapshots,
    ...(records ? { peeled: keepPeeled({ ...base.peeled, ...peeled }, snapshots) } : {}),
    history,
    historyPieces: [...(base.historyPieces || []), ...historyPieces.map((piece) => ({ ...piece, seq }))],
  };
}

// The peeled targets of the tags some snapshot names. A snapshot is how long a
// tag can still be asked for, so it is how long its target is wanted.
function keepPeeled(peeled, snapshots) {
  const named = new Set();
  for (const snapshot of snapshots) for (const oid of Object.values(snapshot.refs)) named.add(oid);
  return Object.fromEntries(Object.entries(peeled).filter(([tag]) => named.has(tag)));
}

// Packs are uploaded before the manifest that names them. This checks it,
// rather than trusting every caller to have done it.
async function assertUploaded(store, base, next) {
  const known = new Set(base.packs.map((pack) => pack.name));
  const added = next.packs.filter((pack) => !known.has(pack.name));
  const knownPieces = new Set((base.historyPieces || []).map((piece) => piece.name));
  added.push(...(next.historyPieces || []).filter((piece) => !knownPieces.has(piece.name)));
  if (next.history && !(base.history && base.history.name === next.history.name)) added.push(next.history);

  for (const pack of added) {
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
// has stalled); it keeps pushes from the same base from all doing the work,
// and lets a push whose base has moved find out before it writes.
async function swap({ store, lock, base, next }) {
  if (typeof lock !== "function") throw new Error("swap needs the host's lock function");
  validate(base);
  validate(next);
  if (next.seq !== base.seq + 1) throw new StaleManifestError("The new manifest does not follow the one it was built on");

  // A manifest is immutable, so one read() would refuse could never be fixed
  // and would leave the repository unreadable: it is never written
  const bytes = serialize(next);
  if (bytes.length > MAX_BYTES) {
    throw new ManifestTooLargeError("The manifest is " + bytes.length + " bytes; the most that can be read back is " + MAX_BYTES);
  }

  await assertUploaded(store, base, next);

  return lock(async () => {
    // Early exit for a base which has already moved on (or never was the
    // newest): the manifest after it exists, or it doesn't. Only advice; a
    // swap which passes this is still decided by the create below. If the
    // manifest after the base is there it may be this very swap, landed on an
    // earlier try, so it is checked rather than assumed to be someone else's.
    const [hasBase, hasNext] = await Promise.all([
      base.seq === 0 ? true : store.head(manifestKey(base.seq)),
      store.head(manifestKey(next.seq)),
    ]);
    if (!hasBase) throw new StaleManifestError("The manifest moved on from seq " + base.seq);

    let landed = hasNext ? await confirm(store, next, null) : null;

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
    remember(store, next.seq, landed || bytes);

    // The swap has happened. The hint only saves the next reader some looking,
    // so a failure to write it is not a failure to swap.
    try {
      await store.put(LATEST_KEY, Buffer.from(JSON.stringify({ seq: next.seq }) + "\n"));
    } catch (err) {}

    return next;
  });
}

module.exports = { VERSION, empty, validate, parse, serialize, read, advance, swap };
