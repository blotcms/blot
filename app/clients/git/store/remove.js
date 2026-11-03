// Removing a whole repository: for a blog that leaves the git client or is
// deleted, and for a copy that is to be imported again from scratch. See
// README, "Removing a repository".
//
// A repository's manifests must never start again at seq 1. Processes keep the
// manifest they last read for up to a day (a writer's base, MAX_BASE_AGE) or
// half a day (bytes kept in memory, RECONFIRM_AFTER), and a writer advances by
// creating seq + 1. If a removal deleted every manifest and an import then
// wrote 1, 2, ... again, a process holding manifest k of the old history could
// create k + 1 on top of the new one, or serve the old k as the newest: the
// conditional create only stops a writer whose next number is taken.
//
// So a removal swaps in a tombstone (manifest.removed: no refs, no packs, a
// new epoch) as the next seq, n + 1, and then deletes the packs and the
// sweep's record it listed before that swap. It deletes no manifest. Every
// number up to the tombstone stays taken, so no writer holding an old
// manifest can create anything: it finds its next number taken, reads again,
// and finds the tombstone's new epoch (a push is refused, compaction is
// superseded, a commit uploads its pack again). A reader holding the bytes of
// an old manifest finds the one after it there, and walks forward to the
// tombstone. Whatever comes next (an import, which manifest.isEmpty lets build
// on the tombstone) goes above it. The old manifests hold refs and object IDs,
// never content, and go with the sweep (a blog still on git) or the host's
// deletion of a prefix nothing uses any more (a blog off git), which must wait
// until no process can still hold a manifest from before the tombstone.
//
// Keys written after the listing are left: an upload for a writer that builds
// on the tombstone happens after it read the tombstone, so after the listing.
//
//   removeRepo({ store, lock?, clock? })
//
// resolves { outcome: "removed", seq, deleted }, where seq is the tombstone's
// (0 if the repository has no manifest, when everything listed is deleted and
// no tombstone is needed) and deleted the number of keys deleted. Running it
// again is safe, and writes no second tombstone while the newest manifest is
// one. A removal that loses its swap to other writers three times throws with
// code EMOVED, and an ambiguous swap throws OutcomeUnknownError; either way
// nothing was deleted, and it can be run again. `lock` is the host's
// per-repository lock, as for manifest.swap (which is all it is held for).
const manifest = require("./manifest");
const { StaleManifestError } = require("./errors");
const { LATEST_KEY, manifestSeq } = require("./layout");

const ATTEMPTS = 3;
const DELETES_AT_ONCE = 16;

async function removeRepo({ store, lock = (fn) => fn(), clock = Date.now }) {
  for (let attempt = 1; ; attempt++) {
    // Listed first: nothing written after the tombstone is in it
    const keys = [];
    for await (const { key } of store.list("")) keys.push(key);

    const base = await manifest.read(store, { clock });
    let tombstone = base;

    if (!manifest.isEmpty(base)) {
      try {
        tombstone = await manifest.swap({ store, lock, base, next: manifest.removed(base), clock });
      } catch (err) {
        if (!(err instanceof StaleManifestError)) throw err;
        if (attempt < ATTEMPTS) continue;
        throw Object.assign(new Error("Other writers kept moving the repository on while it was being removed: " + err.message), { code: "EMOVED", cause: err });
      }
    }

    // With no manifest at all there is no numbering to keep
    const doomed = tombstone.seq === 0 ? keys : keys.filter((key) => key !== LATEST_KEY && manifestSeq(key) === null);

    let next = 0;
    const worker = async () => {
      while (next < doomed.length) await store.delete(doomed[next++]);
    };
    await Promise.all(Array.from({ length: Math.min(DELETES_AT_ONCE, doomed.length) }, worker));

    return { outcome: "removed", seq: tombstone.seq, deleted: doomed.length };
  }
}

module.exports = removeRepo;
