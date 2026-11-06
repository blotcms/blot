import fs from "fs-extra";
import { join, resolve, sep } from "path";
import { iCloudDriveDirectory } from "../config.js";
import clfdate from "../util/clfdate.js";
import normalizeMacserverPath from "./normalizeMacserverPath.js";
import { watch, unwatch } from "../watcher/index.js";
import { forgetPath } from "../pushedFiles.js";

export default async (req, res) => {
  const blogID = req.header("blogID");
  const path = Buffer.from(req.header("pathBase64"), "base64").toString("utf8");
  const normalizedPath = normalizeMacserverPath(path);

  // Validate required headers
  if (!blogID || !path) {
    console.error(
      clfdate(),
      "Missing required headers for delete request",
      { blogID, path }
    );
    return res.status(400).send("Missing required headers: blogID or path");
  }

  console.log(clfdate(), `Received delete request for blogID: ${blogID}, path: ${path}`);

  const basePath = resolve(join(iCloudDriveDirectory, blogID));
  const filePath = resolve(join(basePath, normalizedPath));

  if (filePath !== basePath && !filePath.startsWith(`${basePath}${sep}`)) {
    console.error(clfdate(), 
      "Invalid path: attempted to access parent directory",
      basePath,
      filePath
    );
    return res
      .status(400)
      .send("Invalid path: attempted to access parent directory");
  }

  // The watcher is stopped, so it never sees this removal: forget the path
  // here, or the file put back with the same size and mtime would be skipped
  forgetPath(blogID, normalizedPath);

  // first unwatch the blogID to prevent further events from being triggered
  try {
    await unwatch(blogID);
  } catch (error) {
    console.error(clfdate(), `Failed to unwatch blogID (${blogID}):`, error);
    return res.status(500).send("Failed to unwatch blog folder");
  }

  let success = false;

  try {
    for (let i = 0; i < 10; i++) {
      try {
        await fs.remove(filePath);
        success = true;
        console.log(clfdate(), `Deleted file: ${filePath}`);
        break;
      } catch (error) {
        success = false;
        console.error(clfdate(), `Failed to delete file (${filePath}):`, error);
        await new Promise((resolve) => setTimeout(resolve, 1000 * i)); // Exponential backoff
      }
    }

    console.log(clfdate(), `Handled file deletion: ${filePath}`);

    if (!success) {
      return res.status(500).send("Failed to delete file after retries");
    }

    return res.sendStatus(200);
  } finally {
    // re-watch the blogID
    try {
      await watch(blogID);
    } catch (error) {
      console.error(clfdate(), `Failed to rewatch blogID (${blogID}):`, error);
    }
  }
};
