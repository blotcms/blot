const clfdate = require("helper/clfdate");
const lock = require("helper/lock");
const client = require("models/client");
const establishSyncLock = require("sync/establishSyncLock");
const database = require("../database");
const PREFIX = require("../database/prefix");

const LOCKED = "Failed to acquire folder lock";

// One process at a time walks a blog's Drive folder to find what changed
const walkKey = (blogID) => `${PREFIX}walk:${blogID}`;
// Set when a sync was asked for while another process was walking the blog
const rewalkKey = (blogID) => `${PREFIX}rewalk:${blogID}`;
// How long the walk lock lives without a heartbeat (helper/lock renews it)
const WALK_LOCK_TTL_MS = 30 * 1000;
// Walks run again for requests that arrived during one, at most this many
const MAX_WALKS = 5;

const log = (...args) => console.log(clfdate(), "Google Drive Sync:", ...args);

// Syncs a blog with its Drive folder (#2847):
//
// 1. Walk the whole folder outside the blog's folder lock, changing nothing,
//    to find the directories that differ (sync.js with detectOnly). Only one
//    process walks a blog at a time (its own Redis lock). A request that
//    arrives meanwhile asks the walker to walk once more when it is done, since
//    its change may be newer than the listing, and rejects as locked, so
//    followUpSync keeps a follow-up too.
// 2. If anything differs (or changes.list and the search recorded changed
//    directories, database/dirty.js), take the folder lock and apply just those
//    directories (sync.js's targeted pass). With nothing to change, the folder
//    lock isn't taken at all.
// 3. Walk again, outside the lock, and apply anything still different. The
//    detection after an apply should find nothing it had found before; when it
//    does it is logged (`still differs`), which is how a gap in the targeted
//    pass would show.
//
// So the folder lock, which every other change source (the hot doc poller,
// the dashboard's writes) also needs, is held for the changed directories
// only, not for the whole walk: on a 3,035-item folder the walk took 3.4s.
// If a walk fails, the old way runs: a full walk under the folder lock.
//
// With rethrowLocked, a folder or walk lock held by another sync rejects with
// "Failed to acquire folder lock" instead of resolving false, for callers that
// queue a follow-up (see clients/util/followUpSync).
module.exports = async function (blogID, { rethrowLocked = false } = {}) {
  const sync = require("./sync.js");

  try {
    const account = await database.blog.get(blogID);
    if (!account?.folderId) {
      return;
    }

    // When the blog last had a real sync (webhook, poll or hot doc), for the
    // hourly validation to decide which blogs to check (see ../validate.js).
    // Stamped on the attempt, before the lock, like Dropbox's last_sync. The
    // lock's own "Synced" statuses can't be used for this: the validation
    // takes the lock too.
    await database.blog
      .store(blogID, { lastSync: Date.now() })
      .catch((err) => log("Error stamping lastSync", err));

    let walkLock;
    try {
      walkLock = await lock(walkKey(blogID), { ttl: WALK_LOCK_TTL_MS });
    } catch (err) {
      if (err.code !== "ELOCKED") throw err;
      await client.set(rewalkKey(blogID), "1", { EX: 5 * 60 });
      throw new Error(LOCKED, { cause: err });
    }

    try {
      let result;
      let walks = 0;
      do {
        await client.del(rewalkKey(blogID));
        result = await detectAndApply(blogID, sync);
        walks += 1;
      } while (
        result !== false &&
        walks < MAX_WALKS &&
        (await client.getDel(rewalkKey(blogID)))
      );
      return result;
    } finally {
      await walkLock.release();
    }
  } catch (err) {
    if (rethrowLocked && err.message === LOCKED) throw err;
    log("Sync init failed", err);
    return false;
  }
};

// Resolves to the apply's summary, a truthy summary of the detection when
// nothing needed applying, or false if the sync failed
async function detectAndApply(blogID, sync) {
  const startedAt = Date.now();
  const detected = await sync(blogID, null, null, { detectOnly: true });

  if (detected === false) {
    log(blogID, "detection failed, walking under the folder lock");
    return applyLocked(blogID, sync, { full: true });
  }

  log(
    blogID,
    `detected changed=${detected.changed.length} full=${detected.full} ms=${Date.now() - startedAt}`
  );

  await markDirty(blogID, detected);
  if (!(await database.dirty.count(blogID))) {
    return { downloaded: 0, removed: 0, createdDirs: 0, detected: 0 };
  }

  const applied = await applyLocked(blogID, sync);
  if (applied === false) return false;

  // Check, outside the lock, that the apply left nothing different
  const check = await sync(blogID, null, null, { detectOnly: true });
  if (check && (check.full || check.changed.length)) {
    const again = check.changed.filter((id) => detected.changed.includes(id));
    log(
      blogID,
      `still differs after apply changed=${check.changed.length} full=${check.full} again=${again.length}`
    );
    await markDirty(blogID, check);
    return applyLocked(blogID, sync);
  }

  return applied;
}

async function markDirty(blogID, { changed, full }) {
  if (full) await database.dirty.add(blogID, [database.dirty.FULL]);
  else if (changed.length) await database.dirty.add(blogID, changed);
}

// Under the folder lock, applies the directories in the dirty set, and walks
// everything when asked to (full) or when the set asks for it
async function applyLocked(blogID, sync, { full = false } = {}) {
  const { done, folder } = await establishSyncLock(blogID);
  try {
    // Resolves to sync's summary, or false if the walk failed
    return await sync(blogID, folder.status, folder.update, {
      fullWalk: full ? "always" : "if-asked",
      dirty: {
        FULL: database.dirty.FULL,
        take: () => database.dirty.take(blogID),
        count: () => database.dirty.count(blogID),
        putBack: (ids) => database.dirty.add(blogID, ids),
      },
    });
  } catch (err) {
    log("Sync failed", err);
    return false;
  } finally {
    // It's important to always release the lock
    await done();
  }
}
