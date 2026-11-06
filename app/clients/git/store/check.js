// Checks one repository's copy in the store on its own, reading and writing
// nothing else. The host's daily verifier (served/maintenance.js, and
// scripts/git/verify-store.js by hand) runs these on live blogs, and
// scripts/git/check-store.js on an explicit target, such as a repository
// restored from the offsite copy:
//
//   cheapCheck(store)    the newest manifest, and every file it names is in
//                        the store at the size it says: each pack's .pack,
//                        .idx and .rev, and the history pack's and pieces'
//                        .pack and .idx (they have no .rev). Also that the
//                        manifest is not older than the one latest.json
//                        names, which would mean the newest manifest is gone.
//                        One GET of the hint, one manifest read and a HEAD a
//                        file. Resolves with { state, findings, seq, refs,
//                        packs, files, bytes }, state being "ok", "empty" (no
//                        manifest) or "removed" (a removal's tombstone, an
//                        empty manifest after seq 0); the caller decides what
//                        an empty repository means.
//   deepCheck(options)   a clone of the store through its own clone code, into
//                        scratch, index-pack --strict, fsck --strict, and every
//                        branch, tag, HEAD and peeled tag of the manifest made
//                        in it (verifyImport, with no source). Resolves with
//                        { findings, refs, objects }; a failure which says
//                        nothing about the store (scratch space, the network)
//                        is thrown.
//   verdict(err)         "missing", "mismatch" or null: what an error says
//                        about the store
//
// A finding is { kind: "missing" | "mismatch", detail }.
const manifest = require("./manifest");
const layout = require("./layout");
const { verifyImport } = require("./import");

// HEADs at once for one repository
const HEADS_AT_ONCE = 8;

// The hint is a few bytes; this is only a guard against reading something else
const MAX_HINT_BYTES = 1024;

// Runs fn on each item, `limit` at a time
async function each(items, limit, fn) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker)
  );
}

// An error's message on one line
function scrub(err) {
  return String((err && (err.message || err)) || "unknown error")
    .replace(/\s+/g, " ")
    .trim();
}

// The files the manifest names, with the size each should be (a .rev's is
// not recorded)
function expectedFiles(current) {
  const files = [];

  for (const pack of current.packs) {
    files.push({ key: layout.packKey(pack.name), size: pack.size });
    files.push({ key: layout.idxKey(pack.name), size: pack.idxSize });
    files.push({ key: layout.revKey(pack.name) });
  }

  for (const pack of [current.history, ...(current.historyPieces || [])].filter(
    Boolean
  )) {
    files.push({ key: layout.packKey(pack.name), size: pack.size });
    files.push({ key: layout.idxKey(pack.name), size: pack.idxSize });
  }

  // A pack named twice (a history pack also live, say) is looked at once
  const seen = new Set();
  return files.filter((file) => !seen.has(file.key) && seen.add(file.key));
}

// The seq latest.json names, or null if there is no usable hint. Read before
// the manifest, so a swap landing in between cannot make the hint look ahead.
async function hintedSeq(store) {
  let bytes;
  try {
    bytes = await store.get(layout.LATEST_KEY, { maxBytes: MAX_HINT_BYTES });
  } catch (err) {
    if (err && (err.code === "NOT_FOUND" || err.code === "TOO_LARGE"))
      return null;
    throw err;
  }
  try {
    const seq = JSON.parse(String(bytes)).seq;
    return Number.isSafeInteger(seq) && seq > 0 ? seq : null;
  } catch (err) {
    return null;
  }
}

async function cheapCheck(store) {
  const findings = [];
  const hinted = await hintedSeq(store);
  const current = await manifest.read(store);
  const counts = {
    seq: current.seq,
    refs: Object.keys(current.refs).length,
    packs: current.packs.length,
    files: 0,
    bytes: 0,
  };

  // A manifest is never deleted while it is the newest (the sweep keeps
  // those), so a hint ahead of what read() found is a manifest lost
  if (hinted !== null && hinted > current.seq)
    findings.push({
      kind: "missing",
      detail:
        layout.manifestKey(hinted) +
        " (named by " +
        layout.LATEST_KEY +
        "; the newest manifest found is " +
        current.seq +
        ")",
    });

  if (manifest.isEmpty(current))
    return { state: current.seq ? "removed" : "empty", findings, ...counts };

  const files = expectedFiles(current);
  counts.files = files.length;

  await each(files, HEADS_AT_ONCE, async (file) => {
    const found = await store.head(file.key);
    if (!found)
      return findings.push({
        kind: "missing",
        detail: file.key + " (named by manifest " + current.seq + ")",
      });
    counts.bytes += found.size;
    if (file.size !== undefined && found.size !== file.size)
      findings.push({
        kind: "mismatch",
        detail:
          file.key +
          " is " +
          found.size +
          " bytes; manifest " +
          current.seq +
          " says " +
          file.size,
      });
  });

  findings.sort((a, b) =>
    a.detail < b.detail ? -1 : a.detail > b.detail ? 1 : 0
  );
  return { state: "ok", findings, ...counts };
}

// What git says when the machine, not the cloned bytes, is the problem
const LOCAL_TROUBLE =
  /No space left on device|Permission denied|Too many open files|Read-only file system|Disk quota exceeded|Cannot allocate memory/i;

// The verdict a failure is about the store: "missing" for a file the store
// does not have, "mismatch" for bytes or refs that are wrong (the store's
// CorruptError, which verifyImport also throws when a ref, HEAD or a peeled
// tag cannot be made, or index-pack or fsck failing on the clone). Null for
// anything else (scratch space, the filesystem, the network, the cache's
// room): an error in checking, which says nothing about the store.
function verdict(err) {
  if (!err) return null;
  if (err.code === "NOT_FOUND") return "missing";
  if (err.code === "CORRUPT") return "mismatch";

  const message = String(err.message || "");
  if (
    !err.code &&
    /^git (index-pack|fsck|update-ref|symbolic-ref)\b/.test(message) &&
    !LOCAL_TROUBLE.test(message)
  )
    return "mismatch";

  return null;
}

// `cache` or `scratchDir` as for verifyImport; `gate` decides when each git
// process starts
async function deepCheck({
  store,
  cache = null,
  scratchDir = null,
  gate = null,
}) {
  try {
    const result = await verifyImport({ store, cache, scratchDir, gate });
    return { findings: [], refs: result.refs, objects: result.objects };
  } catch (err) {
    const kind = verdict(err);
    if (!kind) throw err;
    return { findings: [{ kind, detail: scrub(err) }] };
  }
}

module.exports = { cheapCheck, deepCheck, verdict, expectedFiles, scrub };
