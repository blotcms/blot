import fs from "fs-extra";
import {
  getLimiterForBlogID,
  removeLimiterForBlogID,
  getLimiterCount,
} from "../limiters.js";
import clfdate from "../util/clfdate.js";
import {
  forgetBlog,
  forgetPath,
  isKnownDirectory,
  isUnchanged,
  recordDirectory,
  recordPushed,
  recordedPaths,
  startTracking,
  MAX_ENTRIES_PER_BLOG,
} from "../pushedFiles.js";
import { iCloudDriveDirectory } from "../config.js";
import { join } from "path";
import * as brctl from "../brctl/index.js";
import { itemAt } from "../birdState.js";
import { openJournal, startJournal } from "../journal.js";
import status from "../httpClient/status.js";
import { performAction } from "./actions.js";
import {
  startFsWatch as startFsWatchInternal,
  stopFsWatch as stopFsWatchInternal,
} from "./fswatch.js";
import { buildBlogPath, extractBlogID } from "./pathUtils.js";
import {
  isNested,
  refresh as refreshBlogFolder,
  refreshAll as refreshAllBlogFolders,
  rootOf,
} from "../blogFolder.js";
import {
  EVICTION_SUPPRESSION_BLOG_SCOPE,
  markEvictionSuppressed,
  extendEvictionSuppression,
  isEvictionSuppressed,
  waitForEvictionSuppressionToClear,
  pruneEvictionSuppressions,
} from "../evictionSuppression.js";

import {
  checkDiskSpace,
  removeBlog,
  markBlogUpdated,
} from "./monitorDiskUsage.js";

import { realpath } from "fs/promises";
import path from "path";
import shouldIgnore from "./shouldIgnore.js";
import { isActive, markActive, markInactive } from "./activeBlogs.js";

// The watcher is FSEvents (one recursive fs.watch on the iCloud folder, see
// fswatch.js) and nothing else. It used to be chokidar too, polling every file
// of every blog four times a second: that kept the macserver at two busy
// cores, and a change waited for the poll to reach it. FSEvents reports each
// change within a second. Two things it doesn't do are covered here:
// - a folder renamed or moved in is reported, its contents are not, so every
//   folder the watcher reports is walked (requestDirectoryWalk);
// - nothing guarantees an event is never lost, so every few minutes a sweep
//   compares each blog's folder with what was last pushed (sweepBlog), with
//   stat alone, which never downloads anything.

const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const FS_WATCH_SETTLE_DELAY_MS = 300;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function exactCaseViaRealpath(p) {
  const resolved = await realpath(p);
  return resolved === path.resolve(p);
}

// Walks a blog folder (or one directory in it) depth first with readdir and
// lstat, which never materialise anything. Calls onDirectory(path) and
// onFile(path, stat) for each entry that isn't ignored. Resolves to the
// directories that could not be listed, whose contents are then unknown.
const walkTree = async (blogID, top, { onDirectory, onFile }) => {
  const unlisted = [];

  const visit = async (dir) => {
    let entries;
    try {
      entries = await fs.readdir(buildBlogPath(blogID, dir), {
        withFileTypes: true,
      });
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") {
        console.warn(clfdate(), `Could not list ${blogID}/${dir}:`, error.code);
      }
      unlisted.push(dir);
      return;
    }

    for (const entry of entries) {
      const child = dir ? `${dir}/${entry.name}` : entry.name;
      if (shouldIgnore(child)) continue;

      if (entry.isDirectory()) {
        await onDirectory(child);
        await visit(child);
      } else if (entry.isFile()) {
        const stat = await fs
          .lstat(buildBlogPath(blogID, child))
          .catch(() => null);
        if (stat) await onFile(child, stat);
      }
    }
  };

  await visit(top);
  return unlisted;
};

// When a folder is renamed (or moved in) on iCloud, fs.watch reports only the
// new directory, not the files inside it. Once Blot has created a directory,
// walk it and push its contents through the same actions as watcher events.
// The walk runs outside the per-blog limiter (each performAction schedules
// itself), so it cannot deadlock on nested scheduling.
//
// A disk-usage eviction mid-walk suppresses the whole blog, so the walk would
// skip every remaining entry. Walks report when they skipped anything for that
// reason; syncDirectoryContents then waits for the suppression to clear and
// walks the directory again from the top, up to MAX_WALK_RESTARTS times.
const MAX_WALK_RESTARTS = 3;

const syncDirectoryContents = async (blogID, pathInBlogDirectory) => {
  // subfolders this walk went into, walked again on a restart even though
  // they are known by then
  const entered = new Set();

  for (let attempt = 0; attempt <= MAX_WALK_RESTARTS; attempt++) {
    const interrupted = await walkDirectoryContents(
      blogID,
      pathInBlogDirectory,
      entered
    );

    if (!interrupted) return;

    if (attempt === MAX_WALK_RESTARTS) break;

    console.log(
      clfdate(),
      `Directory contents: eviction suppressed the walk, waiting to restart (${attempt + 1}/${MAX_WALK_RESTARTS}), blogID: ${blogID}, path: ${pathInBlogDirectory}`
    );

    if (!(await waitForEvictionSuppressionToClear(blogID))) break;
  }

  console.error(
    clfdate(),
    `Directory contents: giving up on walk after eviction suppression, some entries were skipped, blogID: ${blogID}, path: ${pathInBlogDirectory}`
  );
};

// Returns true if any entry was skipped because of eviction suppression.
const walkDirectoryContents = async (blogID, pathInBlogDirectory, entered) => {
  let entries;
  let interrupted = false;
  // a folder's files are pushed side by side (see limiters.js), its
  // subfolders one after another
  const uploads = [];

  try {
    entries = await fs.readdir(buildBlogPath(blogID, pathInBlogDirectory), {
      withFileTypes: true,
    });
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return false;
    throw error;
  }

  for (const entry of entries) {
    const childPath = `${pathInBlogDirectory}/${entry.name}`;
    const isDirectory = entry.isDirectory();

    if (!isDirectory && !entry.isFile()) continue;
    if (shouldIgnore(childPath)) continue;
    if (isEvictionSuppressed(blogID, childPath)) {
      interrupted = true;
      continue;
    }

    // A subfolder Blot already has gets its own walk whenever the watcher
    // reports it, so it is neither created again nor walked from here:
    // re-walking whole subtrees (and one /mkdir per subfolder) on every
    // report of a big folder would crowd out every blog's uploads
    if (
      isDirectory &&
      isKnownDirectory(blogID, childPath) &&
      !entered.has(childPath)
    )
      continue;

    try {
      if (!(await exactCaseViaRealpath(buildBlogPath(blogID, childPath))))
        continue;

      if (isDirectory) {
        await performAction(blogID, childPath, "mkdir");
        entered.add(childPath);
        if (await walkDirectoryContents(blogID, childPath, entered))
          interrupted = true;
      } else {
        // Files unchanged since their last push are skipped here, without
        // queueing behind the blog's other actions or logging each one
        const stat = await fs
          .stat(buildBlogPath(blogID, childPath))
          .catch(() => null);
        if (stat && isUnchanged(blogID, childPath, stat)) continue;
        console.log(
          clfdate(),
          `Directory contents: upload, blogID: ${blogID}, path: ${childPath}`
        );
        uploads.push(
          performAction(blogID, childPath, "upload").catch((error) =>
            logWalkError(blogID, childPath, error)
          )
        );
      }
    } catch (error) {
      logWalkError(blogID, childPath, error);
    }
  }

  await Promise.all(uploads);
  return interrupted;
};

// performAction has already requested a resync, carry on with the rest
const logWalkError = (blogID, childPath, error) =>
  console.error(
    clfdate(),
    `Error syncing directory contents (${blogID}, ${childPath}):`,
    error
  );

// Walk every directory the watcher reports, not only ones Blot did not already
// have: a child upload or mkdir can create the folder on Blot first, which
// would otherwise make /mkdir report "not created" and skip the walk (some
// children synced, siblings missed). Walks are idempotent (unchanged files are
// skipped and Blot dedupes uploads), and fs.watch reports existing
// directories whenever their contents change, so walks of one directory are
// spaced at least DIRECTORY_WALK_MIN_INTERVAL_MS apart. A request inside that
// window schedules one trailing walk, so late-arriving children are still seen.
const DIRECTORY_WALK_MIN_INTERVAL_MS = 60_000;
const directoryWalks = new Map(); // key -> { lastStart, running, timer }

const requestDirectoryWalk = async (blogID, pathInBlogDirectory) => {
  const key = `${blogID}:${pathInBlogDirectory}`;
  const state = directoryWalks.get(key) || {
    lastStart: 0,
    running: false,
    timer: null,
  };
  directoryWalks.set(key, state);

  if (state.timer) return; // a trailing walk is already scheduled

  const wait = state.lastStart + DIRECTORY_WALK_MIN_INTERVAL_MS - Date.now();

  if (state.running || wait > 0) {
    state.timer = setTimeout(
      () => {
        state.timer = null;
        requestDirectoryWalk(blogID, pathInBlogDirectory).catch((error) =>
          console.error(
            clfdate(),
            `Error walking directory (${blogID}, ${pathInBlogDirectory}):`,
            error
          )
        );
      },
      state.running ? DIRECTORY_WALK_MIN_INTERVAL_MS : wait
    );
    state.timer.unref?.();
    return;
  }

  state.running = true;
  state.lastStart = Date.now();

  try {
    await syncDirectoryContents(blogID, pathInBlogDirectory);
  } finally {
    state.running = false;
    // forget idle directories once their window has passed
    const forget = setTimeout(() => {
      if (
        !state.running &&
        !state.timer &&
        Date.now() - state.lastStart >= DIRECTORY_WALK_MIN_INTERVAL_MS
      ) {
        directoryWalks.delete(key);
      }
    }, DIRECTORY_WALK_MIN_INTERVAL_MS);
    forget.unref?.();
  }
};

// A directory Blot already has isn't sent again, but is still walked: its
// contents may have been moved in with it
const mkdirAndSyncContents = async (blogID, pathInBlogDirectory) => {
  if (!isKnownDirectory(blogID, pathInBlogDirectory)) {
    await performAction(blogID, pathInBlogDirectory, "mkdir");
  }
  await requestDirectoryWalk(blogID, pathInBlogDirectory);
};

// The blog's own folder was deleted or unshared on iCloud
const handleBlogFolderRemoved = async (blogID) => {
  console.warn(clfdate(), `Blog directory deleted: ${blogID}`);
  const limiterCountBefore = getLimiterCount();
  removeLimiterForBlogID(blogID);
  forgetBlog(blogID);
  const limiterCountAfter = getLimiterCount();
  console.assert(
    limiterCountAfter < limiterCountBefore,
    `Expected limiter map size to decrease after deleting ${blogID}. Before: ${limiterCountBefore}, After: ${limiterCountAfter}`
  );
  await status(blogID, {
    error: "Blog directory deleted",
    errorCode: "SOURCE_MISSING",
  });
  await unwatch(blogID); // Stop watching this blog folder
  removeBlog(blogID); // Remove from largest files map
};

// FSEvents reports the blog folder itself. Only a folder that stays gone is
// treated as deleted: iCloud can briefly replace a folder it is updating.
const BLOG_FOLDER_RECHECK_MS = 5_000;
const blogFolderChecks = new Set();

// Whether the blog's shared folder is there. For a nested blog this reads
// its blog_<id> again first, so a folder the owner renamed is found under its
// new name, and Blot is told the name
const blogFolderPresent = async (blogID) => {
  if (!isNested(blogID))
    return fs.pathExists(join(iCloudDriveDirectory, blogID));

  const layout = await refreshBlogFolder(blogID);
  if (layout.renamedFrom) {
    console.log(
      clfdate(),
      `Folder for ${blogID} renamed from "${layout.renamedFrom}" to "${layout.name}"`
    );
    status(blogID, { folderName: layout.name }).catch((error) =>
      console.error(
        clfdate(),
        `Failed to report the folder's new name for ${blogID}:`,
        error.message
      )
    );
  }
  return Boolean(layout.root) && fs.pathExists(layout.root);
};

const reconcileBlogFolderEvent = async (blogID) => {
  if (!isActive(blogID) || blogFolderChecks.has(blogID)) return;
  if (await blogFolderPresent(blogID)) return;

  blogFolderChecks.add(blogID);
  try {
    await delay(BLOG_FOLDER_RECHECK_MS);
    if (!isActive(blogID)) return;
    if (await blogFolderPresent(blogID)) return;
    await handleBlogFolderRemoved(blogID);
  } finally {
    blogFolderChecks.delete(blogID);
  }
};

// One reconcile per path at a time: FSEvents often reports one change several
// times. A report that arrives while the path is being handled runs it once
// more afterwards, so a change in between is not missed.
const reconciling = new Map(); // `${blogID}:${path}` -> { again }

const reconcileFsWatchEvent = async (blogID, pathInBlogDirectory) => {
  if (!pathInBlogDirectory) return reconcileBlogFolderEvent(blogID);

  if (!isActive(blogID)) {
    console.log(
      clfdate(),
      `Dropping fs.watch event for inactive blogID: ${blogID}`
    );
    return;
  }

  if (shouldIgnore(pathInBlogDirectory)) return;

  if (isEvictionSuppressed(blogID, pathInBlogDirectory)) {
    console.log(
      clfdate(),
      `Ignoring FS Watch Event: blogID: ${blogID}, path: ${pathInBlogDirectory} because it is in eviction suppression`
    );
    return;
  }

  const key = `${blogID}:${pathInBlogDirectory}`;
  const running = reconciling.get(key);
  if (running) {
    running.again = true;
    return;
  }

  const state = { again: false };
  reconciling.set(key, state);

  try {
    do {
      state.again = false;
      await delay(FS_WATCH_SETTLE_DELAY_MS);
      await reconcilePath(blogID, pathInBlogDirectory);
    } while (state.again && isActive(blogID));
  } finally {
    reconciling.delete(key);
  }
};

// Lists the folder above a path bird has but the disk doesn't, which asks
// FileProvider for its contents, then looks at the path again. The `ls` of
// whole blogs the monitorer used to run did this for everything; now it is
// done for the one folder that needs it.
const MATERIALISE_ATTEMPTS = 5;
const MATERIALISE_EVERY_MS = 3_000;
const materialising = new Map(); // `${blogID}:${path}` -> { attempts, since }
const gaveUp = []; // when a path was given up on, oldest first

const materialiseLater = (blogID, pathInBlogDirectory) => {
  const key = `${blogID}:${pathInBlogDirectory}`;
  const attempts = (materialising.get(key)?.attempts || 0) + 1;
  const since = materialising.get(key)?.since || Date.now();

  if (attempts > MATERIALISE_ATTEMPTS) {
    materialising.delete(key);
    gaveUp.push(Date.now());
    if (gaveUp.length > 1000) gaveUp.splice(0, gaveUp.length - 1000);
    console.warn(
      clfdate(),
      `bird has ${blogID}/${pathInBlogDirectory} but it never reached the disk; leaving it for the sweep and validation`
    );
    return;
  }

  materialising.set(key, { attempts, since });
  console.log(
    clfdate(),
    `bird has ${blogID}/${pathInBlogDirectory} but the disk doesn't yet, listing its folder (${attempts}/${MATERIALISE_ATTEMPTS})`
  );

  const timer = setTimeout(async () => {
    const parent = path.dirname(buildBlogPath(blogID, pathInBlogDirectory));
    // ls, not readdir: listing through ls is what makes iCloud put the
    // folder's new entries on disk (see brctl/ls.js and monitorer.js)
    await brctl.ls(parent).catch(() => {});
    const there = await fs.pathExists(
      buildBlogPath(blogID, pathInBlogDirectory)
    );
    if (there) materialising.delete(key);
    reconcileFsWatchEvent(blogID, pathInBlogDirectory).catch((error) =>
      console.error(
        clfdate(),
        `Reconcile failed (${blogID}, ${pathInBlogDirectory}):`,
        error
      )
    );
  }, MATERIALISE_EVERY_MS);
  timer.unref?.();
};

const reconcilePath = async (blogID, pathInBlogDirectory) => {
  const fullPath = buildBlogPath(blogID, pathInBlogDirectory);
  let action = null;
  let stats = null;

  try {
    stats = await fs.stat(fullPath);

    // because this runs on macos and the disk is
    // case insensitive, we need to verify that the
    // pathInBlogDirectory is the exact same as the path
    // on the disk – if not, we need to issue a remove event
    if (!(await exactCaseViaRealpath(fullPath))) {
      action = "remove";
    } else if (stats.isFile()) {
      action = "upload";
    } else if (stats.isDirectory()) {
      action = "mkdir";
    }
  } catch (error) {
    if (error.code === "ENOENT") {
      action = "remove";
    } else {
      throw error;
    }
  }

  if (!action) return;

  // bird still has the path, so it has not gone: FileProvider hasn't put it
  // on disk yet (a folder whose contents were never listed, or a move in
  // progress). Sending a removal would delete it from Blot.
  if (
    action === "remove" &&
    stats === null &&
    (await itemAt(blogID, pathInBlogDirectory))
  ) {
    materialiseLater(blogID, pathInBlogDirectory);
    return;
  }

  // the disk has caught up with bird, or bird no longer has the path either
  materialising.delete(`${blogID}:${pathInBlogDirectory}`);

  // FSEvents also reports a file evicted or downloaded again, which leaves
  // its size and mtime alone. The upload skips it (after checking bird's
  // version, see httpClient/upload.js); it is just not logged here.
  if (!(
    action === "upload" && isUnchanged(blogID, pathInBlogDirectory, stats)
  )) {
    console.log(
      clfdate(),
      `FS Watch Event: ${action}, blogID: ${blogID}, path: ${pathInBlogDirectory}`
    );
  }

  markBlogUpdated(blogID);

  if (action === "mkdir") {
    await mkdirAndSyncContents(blogID, pathInBlogDirectory);
  } else {
    await performAction(blogID, pathInBlogDirectory, action);
  }
};

// Every SWEEP_INTERVAL_MS, compare each active blog's folder with what was
// last pushed, and push the difference: files that are new or whose size or
// mtime changed, folders Blot doesn't have, and paths that are gone.
// Removals are the dangerous part, since a wrong one deletes a published post
// from Blot, so a path counts as gone only if its folder listed cleanly, it
// is still gone two seconds later, and the sweep did not find a large share
// of the blog missing at once (which points at a listing problem, not at the
// customer: real deletions arrive through FSEvents anyway).
const SWEEP_REMOVAL_RECHECK_MS = 2_000;
const SWEEP_MAX_MISSING_SHARE = 0.2;
let sweepTimer = null;
let sweeping = false;

const sweepBlog = async (blogID) => {
  if (!isActive(blogID) || isEvictionSuppressed(blogID)) return;

  const recorded = recordedPaths(blogID);

  // Past the cap the record drops its oldest entries, so each upload the
  // sweep made would push out a file it hasn't compared yet, and every
  // sweep would push the whole blog again. Such a blog relies on FSEvents
  // and the journal alone.
  if (recorded.length >= MAX_ENTRIES_PER_BLOG) {
    console.warn(
      clfdate(),
      `Sweep: skipping ${blogID}, it has more files than the record holds`
    );
    return;
  }
  const seen = new Set();
  let pushes = 0;

  const unlisted = await walkTree(blogID, "", {
    onDirectory: async (dir) => {
      seen.add(dir);
      if (!isKnownDirectory(blogID, dir)) {
        pushes++;
        await performAction(blogID, dir, "mkdir");
      }
    },
    onFile: async (file, stat) => {
      seen.add(file);
      if (!isUnchanged(blogID, file, stat)) {
        pushes++;
        console.log(
          clfdate(),
          `Sweep: upload, blogID: ${blogID}, path: ${file}`
        );
        await performAction(blogID, file, "upload");
      }
    },
  });

  if (unlisted.includes("")) return; // the blog folder itself is gone

  const insideUnlisted = (p) =>
    unlisted.some((dir) => p === dir || p.startsWith(dir + "/"));

  const missing = recorded
    .filter(([p]) => !seen.has(p) && !shouldIgnore(p) && !insideUnlisted(p))
    // deepest first, so a removed folder's files go before the folder
    .sort(([a], [b]) => b.length - a.length);

  if (
    missing.length &&
    missing.length > recorded.length * SWEEP_MAX_MISSING_SHARE
  ) {
    console.error(
      clfdate(),
      `Sweep: ${missing.length} of ${recorded.length} paths missing for ${blogID}, not removing any`
    );
    return;
  }

  if (missing.length) await delay(SWEEP_REMOVAL_RECHECK_MS);

  for (const [p] of missing) {
    if (!isActive(blogID)) return;
    if (await fs.pathExists(buildBlogPath(blogID, p))) continue;
    pushes++;
    console.log(clfdate(), `Sweep: remove, blogID: ${blogID}, path: ${p}`);
    await performAction(blogID, p, "remove").catch((error) =>
      console.error(clfdate(), `Sweep: remove failed (${blogID}, ${p}):`, error)
    );
  }

  if (pushes)
    console.log(clfdate(), `Sweep: ${pushes} change(s) for ${blogID}`);
};

const sweepAll = async () => {
  if (sweeping) return;
  sweeping = true;
  const started = Date.now();
  let blogs = 0;

  try {
    const folders = await fs.readdir(iCloudDriveDirectory, {
      withFileTypes: true,
    });
    for (const folder of folders) {
      if (!folder.isDirectory()) continue;
      const blogID = extractBlogID(join(iCloudDriveDirectory, folder.name));
      if (!blogID || !isActive(blogID)) continue;
      blogs++;
      try {
        // A rename FSEvents missed is found here (and reported to Blot)
        if (isNested(blogID)) await blogFolderPresent(blogID);
        await sweepBlog(blogID);
      } catch (error) {
        console.error(clfdate(), `Sweep failed for ${blogID}:`, error);
      }
    }
  } finally {
    sweeping = false;
    console.log(
      clfdate(),
      `Sweep of ${blogs} blog(s) took ${Date.now() - started}ms`
    );
  }
};

const startSweepLoop = () => {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    pruneEvictionSuppressions();
    sweepAll().catch((error) =>
      console.error(clfdate(), "Sweep failed:", error)
    );
  }, SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();
};

const startFsWatch = () => startFsWatchInternal(reconcileFsWatchEvent);
const stopFsWatch = () => stopFsWatchInternal();

// Initializes the top-level watcher and starts disk monitoring
const initialize = async () => {
  // Start periodic disk space monitoring
  checkDiskSpace(async (blogID) => {
    // Get the limiter for this specific blogID
    const limiter = getLimiterForBlogID(blogID);
    let blogPath;
    try {
      blogPath = rootOf(blogID);
    } catch (error) {
      console.error(clfdate(), `Not evicting ${blogID}:`, error.message);
      return;
    }
    const pathInBlogDirectory = EVICTION_SUPPRESSION_BLOG_SCOPE;

    // Schedule the event handler to run within the limiter
    await limiter.schedule(async () => {
      // Events for the blog are dropped while its files are evicted
      await unwatch(blogID);

      markEvictionSuppressed(blogID, pathInBlogDirectory);

      try {
        await brctl.evict(blogPath, { timeoutMs: 60_000 }); // Evict the blog directory
      } catch (error) {
        console.error(
          clfdate(),
          `Failed to evict blog folder (${blogPath}):`,
          error
        );
      } finally {
        extendEvictionSuppression(blogID, pathInBlogDirectory);
      }

      // Re-watch the blogID after eviction
      await watch(blogID);
    });
  });

  // Where each blog's folder is: blog_<id> itself, or nested inside it. The
  // nested folders' names go to Blot, which keeps the one it last heard: a
  // rename made while the macserver was stopped is reported here
  for (const { blogID, name } of await refreshAllBlogFolders()) {
    status(blogID, { folderName: name }).catch((error) =>
      console.error(
        clfdate(),
        `Failed to report the folder's name for ${blogID}:`,
        error.message
      )
    );
  }

  // bird's journal, loaded before the blogs are scanned: it knows which
  // paths changed while the macserver was stopped
  const replay = await openJournal();

  // FSEvents first, so nothing that changes while the blogs are scanned is
  // missed; events for a blog are dropped until its scan is done
  startFsWatch();

  // List all the folders in the iCloudDriveDirectory
  const folderPaths = await fs.readdir(iCloudDriveDirectory, {
    withFileTypes: true,
  });

  // Watch each blog folder
  for (const folder of folderPaths) {
    if (folder.isDirectory()) {
      const blogID = extractBlogID(join(iCloudDriveDirectory, folder.name));
      if (blogID) {
        await watch(blogID).catch((error) =>
          console.error(
            clfdate(),
            `Not watching ${folder.name}:`,
            error.message
          )
        );
      } else {
        console.warn(clfdate(), `Ignoring non-blog folder: ${folder.name}`);
      }
    }
  }

  // The scan took every file on disk to be in sync. Files that changed while
  // the macserver was stopped are forgotten again so they are pushed.
  if (replay && replay.length) {
    for (const { blogID, path: p, isFile } of replay) {
      if (isFile) forgetPath(blogID, p);
    }
    console.log(
      clfdate(),
      `journal: pushing ${replay.length} path(s) changed while stopped`
    );
    for (const { blogID, path: p } of replay) {
      reconcileFsWatchEvent(blogID, p).catch((error) =>
        console.error(clfdate(), `Replay failed (${blogID}, ${p}):`, error)
      );
    }
  }

  startJournal((blogID, p) => {
    reconcileFsWatchEvent(blogID, p).catch((error) =>
      console.error(
        clfdate(),
        `Journal reconcile failed (${blogID}, ${p}):`,
        error
      )
    );
  });

  startSweepLoop();
};

// Watches a specific blog folder. The first time in this process, the files
// already in it are taken to be in sync with Blot and recorded as pushed (the
// hourly validation and resyncs cover anything that changed while the
// macserver was down), so a later eviction or re-materialisation of one, which
// leaves its size and mtime alone, is skipped without a download.
const watch = async (blogID) => {
  // the /watch route passes a header straight through: only a blog folder
  // directly inside the iCloud folder may be walked
  if (typeof blogID !== "string" || !/^blog_[a-zA-Z0-9]+$/.test(blogID)) {
    throw new Error(`Invalid blogID: ${blogID}`);
  }

  if (isActive(blogID)) {
    console.warn(clfdate(), `Already watching blog folder: ${blogID}`);
    return;
  }

  console.log(clfdate(), `Starting watcher for blog folder: ${blogID}`);

  if (startTracking(blogID)) {
    const started = Date.now();
    let files = 0;
    await walkTree(blogID, "", {
      onDirectory: (dir) => recordDirectory(blogID, dir),
      onFile: (file, stat) => {
        files++;
        recordPushed(blogID, file, stat);
      },
    });
    console.log(
      clfdate(),
      `Initial scan complete for blog folder: ${blogID} (${files} files, ${Date.now() - started}ms)`
    );
  }

  // chokidar's initial events used to register every blog with the disk
  // monitor; without them an idle blog could never be evicted
  markBlogUpdated(blogID);
  markActive(blogID);
};

// Unwatches a specific blog folder: its events are dropped from now on
const unwatch = async (blogID) => {
  if (!isActive(blogID)) {
    console.warn(clfdate(), `No active watcher for blog folder: ${blogID}`);
  } else {
    console.log(clfdate(), `Stopping watcher for blog folder: ${blogID}`);
  }
  markInactive(blogID);
};

// For /stats: paths bird has that FileProvider hasn't put on disk yet, and
// how long the oldest has waited. A stalled FileProvider shows up here first.
// Paths are given up on after MATERIALISE_ATTEMPTS listings, so the oldest
// wait stays short even when FileProvider is stuck; how many were given up on
// in the last 15 minutes is what climbs.
const GAVE_UP_WINDOW_MS = 15 * 60_000;
const waitingForFileProvider = (now = Date.now()) => {
  let oldest = null;
  for (const { since } of materialising.values())
    if (oldest === null || since < oldest) oldest = since;
  return {
    count: materialising.size,
    oldestMs: oldest === null ? 0 : now - oldest,
    gaveUpRecently: gaveUp.filter((t) => now - t < GAVE_UP_WINDOW_MS).length,
  };
};

export {
  initialize,
  unwatch,
  watch,
  startFsWatch,
  stopFsWatch,
  waitingForFileProvider,
};
