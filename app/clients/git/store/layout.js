// Where things live inside one repository's object store (S3 keys under the
// store's prefix, which the host sets to git/{blogID}/).
//
//   manifest.json
//   packs/pack-<40 hex>.pack
//   packs/pack-<40 hex>.idx
//
// Packs are immutable and named by content, so a name never refers to two
// different packs and a pack is uploaded once.

const MANIFEST_KEY = "manifest.json";

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

module.exports = { MANIFEST_KEY, PACK_NAME, packKey, idxKey };
