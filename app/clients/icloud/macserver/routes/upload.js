import fs from "fs-extra";
import { randomUUID } from "crypto";
import { tmpdir } from "os";
import { dirname, join, resolve, sep } from "path";
import { iCloudDriveDirectory } from "../config.js";
import { expectBlotChange } from "../blotWrites.js";
import { recordPushed } from "../pushedFiles.js";
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
  const stat = await fs.stat(filePath);
  if (stat.size !== contents.length) {
    throw new Error(`Wrote ${contents.length} bytes but found ${stat.size}`);
  }

  return stat;
}

// The folders above filePath, up to basePath, that don't exist yet: writing
// the file creates them, and the watcher must not send them back to Blot
async function missingParents(basePath, filePath) {
  const missing = [];
  for (
    let dir = dirname(filePath);
    dir.startsWith(`${basePath}${sep}`);
    dir = dirname(dir)
  ) {
    if (await fs.pathExists(dir)) break;
    missing.push(dir.slice(basePath.length + 1));
  }
  return missing;
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

  console.log(
    clfdate(),
    `Received upload request for blogID: ${blogID}, path: ${path}`
  );

  const basePath = resolve(join(iCloudDriveDirectory, blogID));
  const filePath = resolve(join(basePath, normalizedPath));

  if (filePath !== basePath && !filePath.startsWith(`${basePath}${sep}`)) {
    console.error(
      clfdate(),
      "Invalid path: attempted to access parent directory",
      basePath,
      filePath
    );
    return res
      .status(400)
      .send("Invalid path: attempted to access parent directory");
  }

  // The watcher keeps running (see blotWrites.js): the new folders and the
  // written file are recorded, so their events are not sent back to Blot
  for (const dir of await missingParents(basePath, filePath)) {
    expectBlotChange(blogID, dir, "mkdir");
  }

  const modifiedTimeDate = new Date(parseInt(modifiedTime, 10));

  // recorded before the rename too, so an event that arrives before the write
  // returns is already known to be Blot's
  recordPushed(blogID, normalizedPath, {
    size: req.body.length,
    mtimeMs: modifiedTimeDate.getTime(),
  });

  for (let i = 0; i < 10; i++) {
    try {
      const stat = await writeAtomically(filePath, req.body, modifiedTimeDate);
      recordPushed(blogID, normalizedPath, stat);
      console.log(clfdate(), `Wrote file: ${filePath}`);
      return res.sendStatus(200);
    } catch (error) {
      console.error(clfdate(), `Failed to write file (${filePath}):`, error);
      await new Promise((resolve) => setTimeout(resolve, 1000 * i)); // Exponential backoff
    }
  }

  return res.status(500).send("Failed to write file after retries");
};
