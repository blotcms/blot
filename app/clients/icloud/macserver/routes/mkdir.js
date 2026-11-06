import fs from "fs-extra";
import { resolve, join, sep } from "path";
import { iCloudDriveDirectory } from "../config.js";
import { watch, unwatch } from "../watcher/index.js";
import clfdate from "../util/clfdate.js";

export default async (req, res) => {
  const blogID = req.header("blogID");
  const path = Buffer.from(req.header("pathBase64"), "base64").toString("utf8");

  if (!blogID || !path) {
    console.error(
      clfdate(),
      "Missing blogID or path header for mkdir request",
      { blogID, path }
    );
    return res.status(400).send("Missing blogID or path header");
  }

  // Validate path
  const basePath = resolve(join(iCloudDriveDirectory, blogID));
  const dirPath = resolve(join(basePath, path));

  // Check if the resolved path is inside the allowed directory
  if (!(dirPath === basePath || dirPath.startsWith(basePath + sep))) {
    console.error(
      clfdate(),
      "Invalid path: attempted to access parent directory",
      basePath,
      dirPath
    );
    return res
      .status(400)
      .send("Invalid path: attempted to access parent directory");
  }

  console.log(
    clfdate(),
    `Received mkdir request for blogID: ${blogID}, path: ${path}`
  );

  const stat = await fs.stat(dirPath).catch(() => null);

  if (stat && stat.isDirectory()) {
    console.log(clfdate(), `Directory already exists: ${dirPath}`);
    return res.sendStatus(200);
  } else if (stat) {
    try {
      await fs.remove(dirPath);
    } catch (error) {
      console.error(
        clfdate(),
        `Failed to remove existing path (${dirPath}):`,
        error
      );
      return res.status(500).send("Failed to remove existing path");
    }
  }

  console.log(
    clfdate(),
    `Received mkdir request for blogID: ${blogID}, path: ${path}`
  );

  // first unwatch the blogID to prevent further events from being triggered
  try {
    await unwatch(blogID);
  } catch (error) {
    console.error(clfdate(), `Failed to unwatch blogID (${blogID}):`, error);
    return res.status(500).send("Failed to unwatch blog folder");
  }

  let success = false;
  for (let i = 0; i < 5; i++) {
    try {
      await fs.ensureDir(dirPath);
      console.log(clfdate(), `Created directory: ${dirPath}`);
      success = true;
      break;
    } catch (error) {
      console.error(
        clfdate(),
        `Failed to create directory (${dirPath}):`,
        error
      );
      if (i < 4) {
        // Only wait if we're going to retry
        await new Promise((resolve) =>
          setTimeout(resolve, 1000 * Math.pow(2, i))
        ); // True exponential backoff
      }
    }
  }

  // re-watch the blogID
  try {
    await watch(blogID);
  } catch (error) {
    console.error(clfdate(), `Failed to rewatch blogID (${blogID}):`, error);
    return res.status(500).send("Failed to rewatch blog folder");
  }

  if (!success) {
    return res
      .status(500)
      .send("Failed to create directory after multiple attempts");
  }

  res.sendStatus(200);
};
