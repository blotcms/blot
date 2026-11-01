// How the manifest grows as pushes accumulate, with no compaction: computed
// with the foundation's own manifest code, for a repository with one ref
// (Blot's master) where every push adds one pack.
const crypto = require("crypto");
const { manifest } = require("../../../../app/clients/git/store");

function growth(points = [1, 10, 50, 100, 300, 1000, 3000, 10000]) {
  const fake = () => crypto.randomBytes(20).toString("hex");
  let current = manifest.empty();
  const rows = [];
  let cumulative = 0;
  let withoutSnapshots = null;

  for (let push = 1; push <= Math.max(...points); push++) {
    const refs = { "refs/heads/master": fake() };
    current = manifest.advance(current, {
      refs,
      head: "refs/heads/master",
      packs: [{ name: "pack-" + fake(), size: 1500, idxSize: 1200, objects: 8 }],
    });
    const size = manifest.serialize(current).length;
    cumulative += size;
    if (points.includes(push)) {
      withoutSnapshots = manifest.serialize({ ...current, snapshots: [] }).length;
      rows.push({ pushes: push, manifestBytes: size, manifestBytesWithoutSnapshots: withoutSnapshots, manifestObjects: push, allManifestObjectsBytes: cumulative });
    }
  }
  return rows;
}

module.exports = { growth };
