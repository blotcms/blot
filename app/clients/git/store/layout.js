// Where things live inside one repository's object store (S3 keys under the
// store's prefix, which the host sets to git/{blogID}/).
//
//   manifests/<seq>.json         seq zero-padded, so keys sort in order
//   manifests/latest.json        a hint at the newest seq, nothing more
//   packs/pack-<40 hex>.pack
//   packs/pack-<40 hex>.idx
//   packs/pack-<40 hex>.rev      the pack's entries in pack order (see rev.js),
//                                written when a pack is received
//   sweep/pending.json           the packs the sweep has marked to delete on
//                                a later run (see sweep.js)
//
// Packs are immutable and named by content, so a name never refers to two
// different packs and a pack is uploaded once. A numbered manifest is
// immutable too: it is created once, by a conditional write, and never
// overwritten, except by a rewrite's purge, which writes an empty manifest
// (a tombstone) over each one older than its own (see rewrite.js). Only
// latest.json is otherwise overwritten, and it is only a hint (and the sweep's
// record, which only says what to look at again).

const MANIFEST_PREFIX = "manifests/";
const LATEST_KEY = MANIFEST_PREFIX + "latest.json";

// Wide enough that no repository will reach the end of it
const SEQ_DIGITS = 10;
const MANIFEST_NAME = new RegExp("^" + MANIFEST_PREFIX + "(\\d{" + SEQ_DIGITS + "})\\.json$");

const PACK_PREFIX = "packs/";
const PACK_NAME = /^pack-[0-9a-f]{40}$/;
const PACK_FILE = /^packs\/(pack-[0-9a-f]{40})\.(pack|idx|rev)$/;

const SWEEP_KEY = "sweep/pending.json";

function assertPackName(name) {
  if (!PACK_NAME.test(name)) throw new Error("Invalid pack name: " + name);
}

function packKey(name) {
  assertPackName(name);
  return "packs/" + name + ".pack";
}

function idxKey(name) {
  assertPackName(name);
  return "packs/" + name + ".idx";
}

function revKey(name) {
  assertPackName(name);
  return "packs/" + name + ".rev";
}

function manifestKey(seq) {
  if (!Number.isSafeInteger(seq) || seq < 1 || String(seq).length > SEQ_DIGITS) throw new Error("Invalid manifest seq: " + seq);
  return MANIFEST_PREFIX + String(seq).padStart(SEQ_DIGITS, "0") + ".json";
}

// { name, ext } for a pack's .pack, .idx or .rev key, or null for any other key
function packFile(key) {
  const match = PACK_FILE.exec(key);
  return match ? { name: match[1], ext: match[2] } : null;
}

// The seq a manifest key is for, or null if it is some other key (latest.json)
function manifestSeq(key) {
  const match = MANIFEST_NAME.exec(key);
  return match ? Number(match[1]) : null;
}

module.exports = {
  MANIFEST_PREFIX,
  LATEST_KEY,
  PACK_PREFIX,
  PACK_NAME,
  SWEEP_KEY,
  manifestKey,
  manifestSeq,
  packKey,
  idxKey,
  revKey,
  packFile,
};
