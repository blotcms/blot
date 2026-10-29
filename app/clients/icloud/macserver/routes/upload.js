import fs from "fs-extra";
import { randomUUID } from "crypto";
import { tmpdir } from "os";
import { dirname, join, resolve, sep } from "path";
import { iCloudDriveDirectory } from "../config.js";
import { watch, unwatch } from "../watcher/index.js";
import clfdate from "../util/clfdate.js";
import normalizeMacserverPath from "./normalizeMacserverPath.js";

// Writing straight into the iCloud folder with fs.outputFile creates the file
// empty before its contents land. iCloud can register that empty file as a
// cloud version that wins over the local write, so the macserver's next
// brctl download replaces the real contents with 0 bytes. Instead, write the
// file elsewhere on the same volume and rename it into place, so the path
// only ever appears complete.
async function writeAtomically(filePath, contents, modifiedTimeDate) {
  const tempPath = join(tmpdir(), `blot-upload-${randomUUID()}`);

  try {
    await fs.writeFile(tempPath, contents);
    await fs.utimes(tempPath, modifiedTimeDate, modifiedTimeDate);
    await fs.ensureDir(dirname(filePath));
    await fs.rename(tempPath, filePath);
  } finally {
    await fs.remove(tempPath);
  }

  // Confirm iCloud did not swap in another version straight away
  const { size } = await fs.stat(filePath);
  if (size !== contents.length) {
    throw new Error(`Wrote ${contents.length} bytes but found ${size}`);
  }
}

export default async (req, res) => {
  const blogID = req.header("blogID");
  const path = Buffer.from(req.header("pathBase64"), "base64").toString("utf8");
  const modifiedTime = req.header("modifiedTime"); // fs.stat.mtimeMs
  const normalizedPath = normalizeMacserverPath(path);

  if (!blogID || !path || !modifiedTime) {
    console.error(
      clfdate(),
      "Missing blogID, path, or modifiedTime header for upload request",
      { blogID, path, modifiedTime }
    );
    return res.status(400).send("Missing blogID, path, or modifiedTime header");
  }

  console.log(clfdate(), `Received upload request for blogID: ${blogID}, path: ${path}`);

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
        const modifiedTimeDate = new Date(parseInt(modifiedTime, 10));
        await writeAtomically(filePath, req.body, modifiedTimeDate);
        success = true;
        console.log(clfdate(), `Wrote file: ${filePath}`);
        break;
      } catch (error) {
        success = false;
        console.error(clfdate(), `Failed to write file (${filePath}):`, error);
        await new Promise((resolve) => setTimeout(resolve, 1000 * i)); // Exponential backoff
      }
    }

    if (!success) {
      return res.status(500).send("Failed to write file after retries");
    }

    console.log(clfdate(), `Recieved upload of file: ${filePath}`);
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
