// Where things live inside one repository's object store (S3 keys under the
// store's prefix, which the host sets to git/{blogID}/).
//
//   manifests/<seq>.json         seq zero-padded, so keys sort in order
//   manifests/latest.json        a hint at the newest seq, nothing more
//   packs/pack-<40 hex>.pack
//   packs/pack-<40 hex>.idx
//   packs/pack-<40 hex>.rev      the pack's entries in pack order (see rev.js),
//                                written when a pack is received
//
// Packs are immutable and named by content, so a name never refers to two
// different packs and a pack is uploaded once. A numbered manifest is
// immutable too: it is created once, by a conditional write, and never
// overwritten. Only latest.json is overwritten, and it is only a hint.

const MANIFEST_PREFIX = "manifests/";
const LATEST_KEY = MANIFEST_PREFIX + "latest.json";

// Wide enough that no repository will reach the end of it
const SEQ_DIGITS = 10;
const MANIFEST_NAME = new RegExp("^" + MANIFEST_PREFIX + "(\\d{" + SEQ_DIGITS + "})\\.json$");

const PACK_NAME = /^pack-[0-9a-f]{40}$/;

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

// The seq a manifest key is for, or null if it is some other key (latest.json)
function manifestSeq(key) {
  const match = MANIFEST_NAME.exec(key);
  return match ? Number(match[1]) : null;
}

module.exports = { MANIFEST_PREFIX, LATEST_KEY, PACK_NAME, manifestKey, manifestSeq, packKey, idxKey, revKey };
