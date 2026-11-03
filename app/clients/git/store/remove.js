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
// So a removal deletes the packs and the sweep's record, and then swaps in a
// tombstone (manifest.removed: no refs, no packs, a new epoch) on the manifest
// it read before it listed them. It deletes no manifest. Every number up to
// the tombstone stays taken, so no writer holding an old manifest can create
// anything: it finds its next number taken, reads again, and finds the
// tombstone's new epoch. A reader holding the bytes of an old manifest finds
// the one after it there, and walks forward. Whatever comes next (an import,
// which manifest.isEmpty lets build on the tombstone) goes above it.
//
// The deletes come first, and the tombstone only after them, because packs
// are named by their content: an import onto the tombstone uploads the very
// keys the removal listed, and a delete after the tombstone was visible could
// take them from under the import's manifest. Anything built on the tombstone
// read it after it was created, so after every delete of the removal that
// created it. A manifest that lands on the old history while the deletes run
// (it may name a pack just deleted) makes the tombstone's create fail, and the
// removal starts again from it, so the tombstone always ends up on top. If the
// newest manifest is already an empty one and nothing was found to delete, no
// tombstone is written; if something was deleted (an upload for a writer that
// has not swapped yet), a new tombstone goes on top, so that writer's swap
// fails rather than land naming what was deleted.
//
// A newest manifest that cannot be read (damaged, invalid, too large) does not
// stop a removal: the tombstone goes after the largest number listed, by the
// same conditional create.
//
//   removeRepo({ store, lock?, clock? })
//
// resolves { outcome: "removed", seq, deleted }, where seq is the newest
// manifest after the removal, an empty one (0 only if there was nothing to
// delete and no manifest), and deleted the number of keys deleted. Running it again is safe. A removal that
// loses its swap to other writers three times throws with code EMOVED, and an
// ambiguous swap throws OutcomeUnknownError: the packs may then be gone under
// a manifest which still names them, and running it again finishes the job.
// `lock` is the host's per-repository lock, as for manifest.swap (which is all
// it is held for).
const manifest = require("./manifest");
const { StaleManifestError, CorruptError, TooLargeError } = require("./errors");
const { LATEST_KEY, manifestKey, manifestSeq } = require("./layout");

const ATTEMPTS = 3;
const DELETES_AT_ONCE = 16;

async function deleteAll(store, keys) {
  let next = 0;
  const worker = async () => {
    while (next < keys.length) await store.delete(keys[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(DELETES_AT_ONCE, keys.length) }, worker));
}

// The newest manifest, or null if it is there but cannot be read
async function readNewest(store, clock) {
  try {
    return await manifest.read(store, { clock });
  } catch (err) {
    if (err instanceof CorruptError || err instanceof TooLargeError) return null;
    throw err;
  }
}

// Creates a tombstone after the largest manifest number listed, for a newest
// manifest which cannot be read and so cannot be swapped on. Resolves with its
// seq, or null if that number is taken (another writer got there first).
async function tombstoneAfter(store, lock, seqs) {
  const tombstone = manifest.removed({ seq: Math.max(0, ...seqs) });
  const created = await lock(() => store.putIfAbsent(manifestKey(tombstone.seq), manifest.serialize(tombstone)));
  if (!created) return null;
  await store.put(LATEST_KEY, Buffer.from(JSON.stringify({ seq: tombstone.seq }) + "\n")).catch(() => {});
  return tombstone.seq;
}

async function removeRepo({ store, lock = (fn) => fn(), clock = Date.now }) {
  let deleted = 0;
  let lastError = null;

  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    // Read before listing, so the tombstone's create fails if anything was
    // swapped in since
    const base = await readNewest(store, clock);
    const keys = [];
    for await (const { key } of store.list("")) keys.push(key);

    const seqs = keys.map(manifestSeq).filter((seq) => seq !== null);
    const doomed = keys.filter((key) => key !== LATEST_KEY && manifestSeq(key) === null);

    // Already removed (or never written to), and nothing since. Otherwise,
    // even with no manifest yet, the deletes may take an import's uploads,
    // so a tombstone goes on top and that import's swap fails.
    if (base && manifest.isEmpty(base) && !doomed.length) return { outcome: "removed", seq: base.seq, deleted };

    await deleteAll(store, doomed);
    deleted += doomed.length;

    if (!base) {
      const seq = await tombstoneAfter(store, lock, seqs);
      if (seq !== null) return { outcome: "removed", seq, deleted };
      lastError = new StaleManifestError("The manifest after " + Math.max(0, ...seqs) + " was created first");
      continue;
    }

    try {
      const tombstone = await manifest.swap({ store, lock, base, next: manifest.removed(base), clock });
      return { outcome: "removed", seq: tombstone.seq, deleted };
    } catch (err) {
      if (!(err instanceof StaleManifestError)) throw err;
      lastError = err;
    }
  }

  throw Object.assign(new Error("Other writers kept moving the repository on while it was being removed: " + lastError.message), { code: "EMOVED", cause: lastError });
}

module.exports = removeRepo;
