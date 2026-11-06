import chokidar from "chokidar";
import fs from "fs-extra";
import {
  getLimiterForBlogID,
  removeLimiterForBlogID,
  getLimiterCount,
} from "../limiters.js";
import clfdate from "../util/clfdate.js";
import { forgetBlog, isKnownDirectory, isUnchanged, recordDirectory, recordPushed, startTracking } from "../pushedFiles.js";
import { iCloudDriveDirectory } from "../config.js";
import { constants } from "fs";
import { join } from "path";
import * as brctl from "../brctl/index.js";
import status from "../httpClient/status.js";
import { performAction } from "./actions.js";
import { startFsWatch as startFsWatchInternal, stopFsWatch as stopFsWatchInternal } from "./fswatch.js";
import {
  buildBlogPath,
  buildChokidarEventKey,
  assertValidAction,
  extractBlogID,
  extractPathInBlogDirectory,
} from "./pathUtils.js";
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
import { isActive, markActive, markInactive, markStarting } from "./activeBlogs.js";

async function exactCaseViaRealpath(p) {
  const resolved = await realpath(p);
  return resolved === path.resolve(p);
}

// Map to track active chokidar watchers for each blog folder
const blogWatchers = new Map();
const chokidarEventMap = new Map();
const CHOKIDAR_EVENT_WINDOW_MS = 60_000;
const CHOKIDAR_PRUNE_INTERVAL_MS = 30_000;
let chokidarPruneInterval = null;
const FS_WATCH_SETTLE_DELAY_MS = 300;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const recordChokidarEvent = (blogID, pathInBlogDirectory, action) => {
  if (!pathInBlogDirectory) {
    return;
  }

  assertValidAction(action);
  const key = buildChokidarEventKey(blogID, pathInBlogDirectory, action);
  chokidarEventMap.set(key, Date.now());
};

const hasRecentChokidarEvent = (blogID, pathInBlogDirectory, action) => {
  if (!pathInBlogDirectory) {
    return false;
  }

  assertValidAction(action);
  const key = buildChokidarEventKey(blogID, pathInBlogDirectory, action);
  const timestamp = chokidarEventMap.get(key);
  return Boolean(
    timestamp && Date.now() - timestamp < CHOKIDAR_EVENT_WINDOW_MS
  );
};

const pruneChokidarEvents = () => {
  const cutoff = Date.now() - CHOKIDAR_EVENT_WINDOW_MS;
  for (const [key, timestamp] of chokidarEventMap.entries()) {
    if (timestamp < cutoff) {
      chokidarEventMap.delete(key);
    }
  }
};


const startChokidarPruneLoop = () => {
  if (chokidarPruneInterval) {
    return;
  }

  chokidarPruneInterval = setInterval(
    () => {
      pruneChokidarEvents();
      pruneEvictionSuppressions();
    },
    CHOKIDAR_PRUNE_INTERVAL_MS
  );
  chokidarPruneInterval.unref?.();
};

const startFsWatch = () => startFsWatchInternal(reconcileFsWatchEvent);
const stopFsWatch = () => stopFsWatchInternal();

// When a folder is renamed (or moved in) on iCloud, neither chokidar nor
// fs.watch reliably report the files inside it, only the new directory. Once
// Blot has created a directory, walk it and push its contents through the same
// actions as watcher events. The walk runs outside the per-blog limiter (each
// performAction schedules itself), so it cannot deadlock on nested scheduling.
//
// A disk-usage eviction mid-walk suppresses the whole blog, so the walk would
// skip every remaining entry. Walks report when they skipped anything for that
// reason; syncDirectoryContents then waits for the suppression to clear and
// walks the directory again from the top, up to MAX_WALK_RESTARTS times.
const MAX_WALK_RESTARTS = 3;

const syncDirectoryContents = async (blogID, pathInBlogDirectory) => {
  for (let attempt = 0; attempt <= MAX_WALK_RESTARTS; attempt++) {
    const interrupted = await walkDirectoryContents(blogID, pathInBlogDirectory);

    if (!interrupted) return;

    if (attempt === MAX_WALK_RESTARTS) break;

    console.log(clfdate(), `Directory contents: eviction suppressed the walk, waiting to restart (${attempt + 1}/${MAX_WALK_RESTARTS}), blogID: ${blogID}, path: ${pathInBlogDirectory}`);

    if (!(await waitForEvictionSuppressionToClear(blogID))) break;
  }

  console.error(clfdate(), `Directory contents: giving up on walk after eviction suppression, some entries were skipped, blogID: ${blogID}, path: ${pathInBlogDirectory}`);
};

// Returns true if any entry was skipped because of eviction suppression.
const walkDirectoryContents = async (blogID, pathInBlogDirectory) => {
  let entries;
  let interrupted = false;

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
    if (isDirectory && isKnownDirectory(blogID, childPath)) continue;

    try {
      if (!(await exactCaseViaRealpath(buildBlogPath(blogID, childPath)))) continue;

      if (isDirectory) {
        if (!hasRecentChokidarEvent(blogID, childPath, "mkdir")) {
          await performAction(blogID, childPath, "mkdir");
        }
        if (await walkDirectoryContents(blogID, childPath)) interrupted = true;
      } else if (!hasRecentChokidarEvent(blogID, childPath, "upload")) {
        // if chokidar did report the file it is already being uploaded.
        // Files unchanged since their last push are skipped here, without
        // queueing behind the blog's other actions or logging each one
        const stat = await fs.stat(buildBlogPath(blogID, childPath)).catch(() => null);
        if (stat && isUnchanged(blogID, childPath, stat)) continue;
        console.log(clfdate(), `Directory contents: upload, blogID: ${blogID}, path: ${childPath}`);
        await performAction(blogID, childPath, "upload");
      }
    } catch (error) {
      // performAction has already requested a resync, carry on with the rest
      console.error(clfdate(), `Error syncing directory contents (${blogID}, ${childPath}):`, error);
    }
  }

  return interrupted;
};

// Walk every directory the watcher reports, not only ones Blot did not already
// have: a child upload or mkdir can create the folder on Blot first, which
// would otherwise make /mkdir report "not created" and skip the walk (some
// children synced, siblings missed). Walks are idempotent (chokidar-reported
// entries are skipped and Blot dedupes uploads), and fs.watch reports existing
// directories whenever their contents change, so walks of one directory are
// spaced at least DIRECTORY_WALK_MIN_INTERVAL_MS apart. A request inside that
// window schedules one trailing walk, so late-arriving children are still seen.
const DIRECTORY_WALK_MIN_INTERVAL_MS = 60_000;
const directoryWalks = new Map(); // key -> { lastStart, running, timer }

const requestDirectoryWalk = async (blogID, pathInBlogDirectory) => {
  const key = `${blogID}:${pathInBlogDirectory}`;
  const state = directoryWalks.get(key) || { lastStart: 0, running: false, timer: null };
  directoryWalks.set(key, state);

  if (state.timer) return; // a trailing walk is already scheduled

  const wait = state.lastStart + DIRECTORY_WALK_MIN_INTERVAL_MS - Date.now();

  if (state.running || wait > 0) {
    state.timer = setTimeout(
      () => {
        state.timer = null;
        requestDirectoryWalk(blogID, pathInBlogDirectory).catch((error) =>
          console.error(clfdate(), `Error walking directory (${blogID}, ${pathInBlogDirectory}):`, error)
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
      if (!state.running && !state.timer && Date.now() - state.lastStart >= DIRECTORY_WALK_MIN_INTERVAL_MS) {
        directoryWalks.delete(key);
      }
    }, DIRECTORY_WALK_MIN_INTERVAL_MS);
    forget.unref?.();
  }
};

const mkdirAndSyncContents = async (blogID, pathInBlogDirectory) => {
  await performAction(blogID, pathInBlogDirectory, "mkdir");
  await requestDirectoryWalk(blogID, pathInBlogDirectory);
};

// Handle file events
const handleFileEvent = async (event, blogID, filePath) => {
  try {
    const pathInBlogDirectory = extractPathInBlogDirectory(filePath);

    if (shouldIgnore(pathInBlogDirectory)) {
      console.log(clfdate(), `Ignoring file event: ${event}, blogID: ${blogID}, path: ${pathInBlogDirectory} because it matches the shouldIgnore filter`);
      return;
    }

    // Handle the deletion of the entire blog directory
    if (event === "unlinkDir" && pathInBlogDirectory === "") {
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
      return;
    }

    try {
      // Check if the directory for the blogID exists
      await fs.access(join(iCloudDriveDirectory, blogID), constants.F_OK);
    } catch (err) {
      console.warn(clfdate(), `Ignoring event for unregistered blogID: ${blogID}`);
      return;
    }

    if (!pathInBlogDirectory) {
      console.warn(clfdate(), `Failed to parse path from path: ${filePath}`);
      return;
    }

    console.log(clfdate(), 
      `Chokidar Event: ${event}, blogID: ${blogID}, path: ${pathInBlogDirectory}`
    );

    // because this runs on macos and the disk is 
    // case insensitive, we need to verify that the
    // pathInBlogDirectory is the exact same as the path
    // on the disk – if not, we need to issue a remove event
    if (event === "add" || event === "change") {
      try {
        const fullPath = buildBlogPath(blogID, pathInBlogDirectory);
        const exactCase = await exactCaseViaRealpath(fullPath);
        if (!exactCase) {
          console.log(clfdate(), `Chokidar Event: Changing event from add/change to remove for path: ${pathInBlogDirectory} because of case mismatch`);
          event = "unlink";
        }
      } catch (error) {
        console.error(clfdate(), `Error verifying exact case for path: ${fullPath}:`, error);
        return;
      }
    }

    if (event === "add" || event === "change") {
      await performAction(blogID, pathInBlogDirectory, "upload");
    } else if (event === "unlink" || event === "unlinkDir") {
      await performAction(blogID, pathInBlogDirectory, "remove");
    } else if (event === "addDir") {
      await mkdirAndSyncContents(blogID, pathInBlogDirectory);
    }
  } catch (error) {
    console.error(clfdate(), `Error handling file event (${event}, ${filePath}):`, error);
  }
};


const reconcileFsWatchEvent = async (blogID, pathInBlogDirectory) => {
  if (!isActive(blogID)) {
    console.log(clfdate(), `Dropping fs.watch event for inactive blogID: ${blogID}`);
    return;
  }

  // This will skip blog directory deletions
  // but that's OK!
  if (!pathInBlogDirectory) {
    console.log(clfdate(), `Ignoring FS Watch Event: blogID: ${blogID}, path: ${pathInBlogDirectory} because it is falsy`);
    return;
  }

  if (shouldIgnore(pathInBlogDirectory)) {
    console.log(clfdate(), `Ignoring FS Watch Event: blogID: ${blogID}, path: ${pathInBlogDirectory} because it matches the shouldIgnore filter`);
    return;
  }

  if (isEvictionSuppressed(blogID, pathInBlogDirectory)) {
    console.log(clfdate(), `Ignoring FS Watch Event: blogID: ${blogID}, path: ${pathInBlogDirectory} because it is in eviction suppression`);
    return;
  }

  await delay(FS_WATCH_SETTLE_DELAY_MS);

  const fullPath = buildBlogPath(blogID, pathInBlogDirectory);
  let action = null;

  try {
    const stats = await fs.stat(fullPath);

    const exactCase = await exactCaseViaRealpath(fullPath);

    // because this runs on macos and the disk is 
    // case insensitive, we need to verify that the
    // pathInBlogDirectory is the exact same as the path
    // on the disk – if not, we need to issue a remove event
    if (!exactCase) {
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

  if (!action) {
    return;
  }

  if (hasRecentChokidarEvent(blogID, pathInBlogDirectory, action)) {
    console.log(clfdate(), `FS Watch Event: duplicate, action: ${action}, blogID: ${blogID}, path: ${pathInBlogDirectory}`);
    return;
  }

  console.log(clfdate(), `FS Watch Event: ${action}, blogID: ${blogID}, path: ${pathInBlogDirectory}`);
  if (action === "mkdir") {
    await mkdirAndSyncContents(blogID, pathInBlogDirectory);
  } else {
    await performAction(blogID, pathInBlogDirectory, action);
  }
};

// Initializes the top-level watcher and starts disk monitoring
const initialize = async () => {
  // Start periodic disk space monitoring
  checkDiskSpace(async (blogID) => {
    // Get the limiter for this specific blogID
    const limiter = getLimiterForBlogID(blogID);
    const blogPath = join(iCloudDriveDirectory, blogID);
    const pathInBlogDirectory = EVICTION_SUPPRESSION_BLOG_SCOPE;

    // Schedule the event handler to run within the limiter
    await limiter.schedule(async () => {
      // Unwatch the blogID to prevent file locks during eviction
      await unwatch(blogID);

      markEvictionSuppressed(blogID, pathInBlogDirectory);

      try {
        await brctl.evict(blogPath, { timeoutMs: 60_000 }); // Evict the blog directory
      } catch (error) {
        console.error(clfdate(), `Failed to evict blog folder (${blogPath}):`, error);
      } finally {
        extendEvictionSuppression(blogID, pathInBlogDirectory);
      }

      // Re-watch the blogID after eviction
      await watch(blogID);
    });
  });

  // List all the folders in the iCloudDriveDirectory
  const folderPaths = await fs.readdir(iCloudDriveDirectory, {
    withFileTypes: true,
  });

  // Watch each blog folder
  for (const folder of folderPaths) {
    if (folder.isDirectory()) {
      const blogID = extractBlogID(join(iCloudDriveDirectory, folder.name));
      if (blogID) {
        await watch(blogID);
      } else {
        console.warn(clfdate(), `Ignoring non-blog folder: ${folder.name}`);
      }
    }
  }

  startChokidarPruneLoop();
  startFsWatch();
};

// Watches a specific blog folder
const watch = async (blogID) => {
  if (blogWatchers.has(blogID)) {
    console.warn(clfdate(), `Already watching blog folder: ${blogID}`);

    if (isActive(blogID)) {
      markActive(blogID);
    }

    return;
  }

  const blogPath = join(iCloudDriveDirectory, blogID);
  let initialScanComplete = false;
  const recordInitialScan = startTracking(blogID);

  console.log(clfdate(), `Starting watcher for blog folder: ${blogID}`);
  // Monitor the CPU usage on the macserver before and after
  // making any changes to the polling intervals
  const watcher = chokidar
    .watch(blogPath, {
      // we need to use polling otherwise we get this error on server start:
      // Watcher error: Error: EMFILE: too many open files, watch
      // IF in future, we can get rid of polling, perhaps we can remove the watch/unwatch calls in the rest of the code?
      // This might work. We also might be able to leverage
      // chokidar.watcher.add() and chokidar.watcher.unwatch() to manage files more specifically, reducing the risk of missed events and sync drift?
      usePolling: true,
      interval: 250, // Poll every 0.25s for non-binary files
      binaryInterval: 1000, // Poll every 1s for binary files
      ignoreInitial: false, // Process initial events
      alwaysStat: true, // so the initial scan can record each file's size and mtime
    })
    .on("all", (event, filePath, stats) => {
      const blogID = extractBlogID(filePath);
      const pathInBlogDirectory = extractPathInBlogDirectory(filePath);
      const action =
        event === "add" || event === "change"
          ? "upload"
          : event === "unlink" || event === "unlinkDir"
            ? "remove"
            : event === "addDir"
              ? "mkdir"
              : null;

      if (!blogID) {
        console.warn(clfdate(), `Failed to parse blogID from path: ${filePath}`);
        return;
      }

      if (
        event === "add" ||
        event === "change" ||
        event === "unlink" ||
        event === "unlinkDir" ||
        event === "addDir"
      ) {
        markBlogUpdated(blogID);
      }

      // Files already here when the blog is first watched are taken to be in
      // sync with Blot (their initial events are not pushed), so record them
      // as pushed: a later eviction or re-materialisation of one, which leaves
      // its size and mtime alone, is then skipped without a download.
      if (recordInitialScan && !initialScanComplete && event === "add" && stats) {
        recordPushed(blogID, pathInBlogDirectory, stats);
      }
      if (recordInitialScan && !initialScanComplete && event === "addDir" && pathInBlogDirectory) {
        recordDirectory(blogID, pathInBlogDirectory);
      }

      // We only handle file events after the initial scan is complete
      if (initialScanComplete && action) {
        assertValidAction(action);
        recordChokidarEvent(blogID, pathInBlogDirectory, action);
        handleFileEvent(event, blogID, filePath);
      }
    })
    .on("ready", () => {
      console.log(clfdate(), `Initial scan complete for blog folder: ${blogID}`);
      initialScanComplete = true; // Mark the initial scan as complete
      markActive(blogID);
    })
    .on("error", (error) => console.error(clfdate(), `Watcher error: ${error}`));

  blogWatchers.set(blogID, watcher);
  markStarting(blogID);
};

// Unwatches a specific blog folder
const unwatch = async (blogID) => {
  const watcher = blogWatchers.get(blogID);
  if (!watcher) {
    console.warn(clfdate(), `No active watcher for blog folder: ${blogID}`);
    markInactive(blogID);
    return;
  }

  console.log(clfdate(), `Stopping watcher for blog folder: ${blogID}`);
  await watcher.close();
  blogWatchers.delete(blogID);
  markInactive(blogID);
};

export { initialize, unwatch, watch, startFsWatch, stopFsWatch };
