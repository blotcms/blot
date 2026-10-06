import chokidar from "chokidar";
import fs from "fs-extra";
import {
  getLimiterForBlogID,
  removeLimiterForBlogID,
  getLimiterCount,
} from "../limiters.js";
import clfdate from "../util/clfdate.js";
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
      await performAction(blogID, pathInBlogDirectory, "mkdir");
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
  await performAction(blogID, pathInBlogDirectory, action);
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
    })
    .on("all", (event, filePath) => {
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
