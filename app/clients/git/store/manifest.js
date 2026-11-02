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
// ones and any written recently. Snapshots are trimmed from the old end by
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

// When this process read each manifest read() returned, by the object
// itself, by its own clock. Never part of the manifest's bytes.
const readAt = new WeakMap();

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
//
// The manifest returned is stamped with when it was read (`clock`, Date.now
// unless given), which is the time swap() goes by when it is a base.
async function read(store, { clock = Date.now } = {}) {
  const stamp = (m) => (readAt.set(m, clock()), m);
  const hinted = await walkFromHint(store);
  if (hinted !== null) {
    try {
      return stamp(await load(store, hinted));
    } catch (err) {
      if (!(err instanceof NotFoundError)) throw err;
    }
  }

  const newest = await listNewest(store);
  return stamp(newest === 0 ? empty() : await load(store, newest));
}

// Throws StaleManifestError if `base` was read (or swapped in) by this process
// more than MAX_BASE_AGE ago. A base read() did not return (built by hand, or
// a copy) has no time and passes; every writer here swaps the very object
// read() gave it.
function assertFresh(base, clock) {
  const at = readAt.get(base);
  if (at !== undefined && clock() - at > MAX_BASE_AGE) {
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
// A base read more than MAX_BASE_AGE ago (by `clock`, Date.now unless given)
// is refused with StaleManifestError, before any request and again just
// before the create, so the writer reads again through its usual stale path.
// That is what keeps the conditional create safe once the sweep deletes old
// manifests: read() returned the newest manifest k, so k + 1 did not exist
// then, and any k + 1 there is now was written since, less than a day ago.
// The sweep deletes only manifests older than its recovery window (at least
// two days), so the key this create targets was never one it deleted.
async function swap({ store, lock, base, next, uploaded = [], clock = Date.now }) {
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
    remember(store, next.seq, landed || bytes);
    // next + 1 did not exist when this create landed, so `next` is as fresh a
    // base as one just read
    readAt.set(next, clock());

    // The swap has happened. The hint only saves the next reader some looking,
    // so a failure to write it is not a failure to swap.
    try {
      await store.put(LATEST_KEY, Buffer.from(JSON.stringify({ seq: next.seq }) + "\n"));
    } catch (err) {}

    return next;
  });
}

module.exports = {
  VERSION,
  MAX_BYTES,
  MAX_BASE_AGE,
  SNAPSHOT_LIMITS,
  empty,
  validate,
  parse,
  serialize,
  read,
  advance,
  compacted,
  trimSnapshots,
  snapshotBytes,
  packsNamed,
  swap,
};
