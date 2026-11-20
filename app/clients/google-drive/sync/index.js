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
// 0. Apply, under the folder lock, the directories changes.list and the
//    search already recorded as changed (database/dirty.js), so a change they
//    saw doesn't wait for the walk.
// 1. Walk the whole folder outside the blog's folder lock, changing nothing,
//    to find the directories that differ (sync.js with detectOnly). Only one
//    process walks a blog at a time (its own Redis lock). A request that
//    arrives meanwhile asks the walker to walk once more when it is done, since
//    its change may be newer than the listing, and rejects as locked, so
//    followUpSync keeps a follow-up too.
// 2. If anything differs (or changes.list and the search recorded more changed
//    directories meanwhile), take the folder lock and apply just those
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
module.exports = async function (
  blogID,
  { rethrowLocked = false, trigger = "queued" } = {}
) {
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
        result = await detectAndApply(blogID, sync, trigger, account);
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

// A detection that makes way for directories changes.list recorded meanwhile
// restarts after applying them, at most this many times before it walks to
// the end regardless
const MAX_DETECT_YIELDS = 5;

// The blog's directories that changed in the last few minutes
// (database/recent.js), at most this many
const MAX_HOT_DIRS = 16;

// Checks the blog's recently changed directories, one listing each, beside
// the full detection, and records any that differ, so the full detection
// makes way for them (#2847). A webhook usually means another change in a
// folder that just changed, and on a large folder the full walk takes up to
// 3.4s to reach it. Never rejects: it only ever adds to the full detection.
async function detectHot(blogID, sync, trigger, account) {
  try {
    const hot = (
      await database.recent.list(account.serviceAccountId, MAX_HOT_DIRS * 4)
    )
      .filter((dir) => dir.blogID === blogID)
      .map((dir) => dir.dirId)
      .slice(0, MAX_HOT_DIRS);
    if (!hot.length) return;
    const startedAt = Date.now();
    const found = await sync(blogID, null, null, {
      detectOnly: true,
      only: hot,
    });
    if (!found || !(found.changed.length || found.full)) return;
    log(
      blogID,
      `hot detected changed=${found.changed.length} full=${found.full} ms=${Date.now() - startedAt}`,
      `trigger=${trigger}`,
      `paths=${JSON.stringify((found.paths || []).slice(0, 20))}`
    );
    await markDirty(blogID, found, `hot:${trigger}`, account);
  } catch (err) {
    log(blogID, "hot detection failed", err.message);
  }
}

// Walks without the folder lock and resolves { changed, full } (sync.js with
// detectOnly), { yielded: true } when it stopped to let recorded directories
// go first, or false if it failed
const detect = (blogID, sync, canYield) =>
  sync(blogID, null, null, {
    detectOnly: true,
    ...(canYield
      ? { dirty: { members: () => database.dirty.members(blogID) } }
      : {}),
  });

// Resolves to the apply's summary, a truthy summary of the detection when
// nothing needed applying, or false if the sync failed
async function detectAndApply(blogID, sync, trigger, account) {
  // Directories changes.list and the search already saw change are applied
  // before walking, and whenever more are recorded while it walks: the walk
  // takes seconds on a large folder, and they don't need it to be found
  // (#2847). A webhook usually starts the walk a moment before changes.list
  // has the change.
  let known = null;
  let detected;
  let startedAt;
  for (let yields = 0; ; yields++) {
    if (await database.dirty.count(blogID)) {
      known = await applyLocked(blogID, sync);
      if (known === false) return false;
    }
    startedAt = Date.now();
    const hot = yields === 0 ? detectHot(blogID, sync, trigger, account) : null;
    detected = await detect(blogID, sync, yields < MAX_DETECT_YIELDS);
    await hot;
    if (!detected || !detected.yielded) break;
    log(
      blogID,
      `detection yielded n=${yields + 1} ms=${Date.now() - startedAt}`
    );
  }

  if (detected === false) {
    log(blogID, "detection failed, walking under the folder lock");
    return applyLocked(blogID, sync, { full: true });
  }

  log(
    blogID,
    `detected changed=${detected.changed.length} full=${detected.full} ms=${Date.now() - startedAt}`,
    // What started the sync, and which directories the walk found, so each can
    // be matched with the source that saw it change first (#2847)
    `trigger=${trigger}`,
    `paths=${JSON.stringify((detected.paths || []).slice(0, 20))}`
  );

  await markDirty(blogID, detected, `walk:${trigger}`, account);
  if (!(await database.dirty.count(blogID))) {
    return known || { downloaded: 0, removed: 0, createdDirs: 0, detected: 0 };
  }

  const applied = await applyLocked(blogID, sync);
  if (applied === false) return false;

  // Check, outside the lock, that the apply left nothing different. A check
  // that makes way leaves the new directories to the next walk, which the
  // request that recorded them asked for (the rewalk flag).
  const check = await detect(blogID, sync, true);
  if (check && !check.yielded && (check.full || check.changed.length)) {
    const again = check.changed.filter((id) => detected.changed.includes(id));
    log(
      blogID,
      `still differs after apply changed=${check.changed.length} full=${check.full} again=${again.length}`
    );
    await markDirty(blogID, check, `check:${trigger}`, account);
    return applyLocked(blogID, sync);
  }

  return applied;
}

// source names the walk and what started it, for the live line (#2847).
// The directories are listed again and again for the next few minutes too
// (serviceAccount/pollRecentFolders.js).
async function markDirty(blogID, { changed, full }, source, account) {
  if (full) await database.dirty.add(blogID, [database.dirty.FULL]);
  else if (changed.length) {
    await database.dirty.add(blogID, changed, source);
    await database.recent
      .touch(account?.serviceAccountId, blogID, changed)
      .catch((err) => log(blogID, "recent touch failed", err.message));
  }
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
        members: () => database.dirty.members(blogID),
        moveHint: (id) => database.dirty.moveHint(blogID, id),
        seen: (ids) => database.dirty.seen(blogID, ids),
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
