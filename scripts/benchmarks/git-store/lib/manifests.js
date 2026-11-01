// The manifest operations of one repository for the harness: the foundation's
// own (manifest.read and manifest.swap), with the host's lock supplied.
//
// A read is the hint (one GET), a HEAD of the next number (normally a miss),
// then a GET of the manifest, which is immutable and so is kept by the
// foundation after the first. A swap checks that the packs it names are
// uploaded (two HEADs a pack), checks the base and the new number (two HEADs),
// creates manifests/<seq>.json with a conditional PUT and writes the hint.
const { manifest } = require("../../../../app/clients/git/store");

function createManifests({ store, lock = (fn) => fn() }) {
  return {
    read: () => manifest.read(store),
    swap: ({ base, next }) => manifest.swap({ store, lock, base, next }),
  };
}

module.exports = createManifests;
