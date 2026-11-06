import fs from "node:fs";
import { join } from "path";
import clfdate from "../util/clfdate.js";
import { iCloudDriveDirectory } from "../config.js";
import { extractBlogID, extractPathInBlogDirectory } from "./pathUtils.js";

let fsWatcher = null;

const startFsWatch = (reconcileFsWatchEvent) => {
  if (fsWatcher) {
    console.warn(clfdate(), "fs.watch already running.");
    return;
  }

  fsWatcher = fs.watch(
    iCloudDriveDirectory,
    { recursive: true },
    (eventType, filename) => {
      if (!filename) {
        return;
      }

      const relativePath =
        typeof filename === "string" ? filename : filename.toString();
      const fullPath = join(iCloudDriveDirectory, relativePath);
      const blogID = extractBlogID(fullPath);
      const pathInBlogDirectory = extractPathInBlogDirectory(fullPath);

      if (!blogID || !pathInBlogDirectory) {
        return;
      }

      reconcileFsWatchEvent(blogID, pathInBlogDirectory).catch((error) => {
        console.error(
          clfdate(),
          `fs.watch reconciliation error for ${blogID}/${pathInBlogDirectory}:`,
          error
        );
      });
    }
  );

  fsWatcher.on("error", (error) => {
    console.error(clfdate(), "fs.watch error:", error);
  });

  console.log(clfdate(), "Started fs.watch on iCloud Drive directory.");
};

const stopFsWatch = () => {
  if (!fsWatcher) {
    return;
  }

  fsWatcher.close();
  fsWatcher = null;
  console.log(clfdate(), "Stopped fs.watch on iCloud Drive directory.");
};

export { startFsWatch, stopFsWatch };
