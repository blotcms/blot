// The manifest: the one small document per repository which says what the
// repository is. Everything else in the bucket is immutable packs; the
// manifest is rewritten on every push, after the packs it names are uploaded,
// and a repository's state is whatever its manifest says.
//
//   {
//     "version": 1,
//     "seq": 7,                      changes by one with every swap
//     "head": "refs/heads/master",   the branch HEAD points at, or null
//     "refs": { "refs/heads/master": "<oid>", ... },
//     "packs": [                     the live packs, oldest first
//       { "name": "pack-<sha1>", "size": 123, "idxSize": 45, "objects": 9, "seq": 7 }
//     ],                             (seq: the swap which added the pack)
//     "snapshots": [ { "seq": 7, "refs": { ... } } ],
//                                    the refs as they were after each push
//     "history": null | { "name", "size", "idxSize", "objects", "through": 7 }
//                                    the pack holding the history up to a swap
//   }
//
// There are no conditional writes in the S3 subset we use, so a swap is made
// safe by the host's lock instead: swap() takes it, checks under it that the
// manifest is still the one the caller built on, and writes.
const { CorruptError, StaleManifestError } = require("./errors");
const { MANIFEST_KEY, PACK_NAME, packKey, idxKey } = require("./layout");

const VERSION = 1;

// A manifest is small; this is only a guard against reading something else
const MAX_BYTES = 64 * 1024 * 1024;

const OID = /^[0-9a-f]{40}$/;

function empty() {
  return { version: VERSION, seq: 0, head: null, refs: {}, packs: [], snapshots: [], history: null };
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

// The repository's manifest, read from the store (never from the cache: only
// the store knows whether it is the current one). A repository nothing has
// been pushed to has none, which reads as an empty one with seq 0.
async function read(store) {
  if (!(await store.head(MANIFEST_KEY))) return empty();
  return parse(await store.get(MANIFEST_KEY, { maxBytes: MAX_BYTES }));
}

// The manifest which follows `base` after a push: `refs` are all the refs now,
// `packs` the packs the push added (already uploaded), `head` and `history`
// are changed only if given. The ref snapshot for the push is recorded.
function advance(base, { refs, packs = [], head = base.head, history = base.history }) {
  const seq = base.seq + 1;
  return {
    ...base,
    seq,
    head,
    refs: { ...refs },
    packs: [...base.packs, ...packs.map((pack) => ({ ...pack, seq }))],
    snapshots: [...base.snapshots, { seq, refs: { ...refs } }],
    history,
  };
}

// Packs are uploaded before the manifest that names them. This checks it,
// rather than trusting every caller to have done it.
async function assertUploaded(store, base, next) {
  const known = new Set(base.packs.map((pack) => pack.name));
  const added = next.packs.filter((pack) => !known.has(pack.name));
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

// Replaces `base`, the manifest the caller built `next` from, with `next`.
//
// `lock(fn)` is the host's per-repository lock: it runs fn while holding the
// lock and resolves with fn's result. It need only be held for this call.
// Throws StaleManifestError, writing nothing, if the manifest is no longer
// `base` (someone swapped first, so the caller starts again from the new one),
// if next is not the manifest after base, or if a pack it names isn't uploaded.
async function swap({ store, lock, base, next }) {
  if (typeof lock !== "function") throw new Error("swap needs the host's lock function");
  validate(base);
  validate(next);
  if (next.seq !== base.seq + 1) throw new StaleManifestError("The new manifest does not follow the one it was built on");

  await assertUploaded(store, base, next);

  return lock(async () => {
    const current = await read(store);
    if (current.seq !== base.seq) {
      throw new StaleManifestError("The manifest moved from seq " + base.seq + " to " + current.seq);
    }
    await store.put(MANIFEST_KEY, serialize(next));
    return next;
  });
}

module.exports = { VERSION, empty, validate, parse, serialize, read, advance, swap };
