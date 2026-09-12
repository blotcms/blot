import fs from "fs-extra";
import { join, resolve, sep } from "path";
import { iCloudDriveDirectory } from "../config.js";
import { ls } from "../brctl/index.js";
import shouldIgnoreFile from '../../../util/shouldIgnoreFile.js';
import clfdate from "../util/clfdate.js";

export default async (req, res) => {
  const blogID = req.header("blogID");
  const path = Buffer.from(req.header("pathBase64"), "base64").toString("utf8");

  if (!blogID || !path) {
    console.error(
      clfdate(),
      "Missing blogID or path header for readdir request",
      { blogID, path }
    );
    return res.status(400).send("Missing blogID or path header");
  }

  console.log(clfdate(), `Received readdir request for blogID: ${blogID}, path: ${path}`);

  const basePath = resolve(join(iCloudDriveDirectory, blogID));
  const dirPath = resolve(join(basePath, path));

  if (dirPath !== basePath && !dirPath.startsWith(`${basePath}${sep}`)) {
    console.error(clfdate(), 
      "Invalid path: attempted to access parent directory",
      basePath,
      dirPath
    );
    return res
      .status(400)
      .send("Invalid path: attempted to access parent directory");
  }

  // first we issue a request to ls to ensure the directory is downloaded
  // otherwise, files or subdirectories may be missing. if this stops working
  // you can use brctl monitor -p [path] to force iCloud to sync the directory
  // listing (this will not download the files, just the list of contents)
  // `ls` (brctl/ls.js) does NOT throw on failure: it returns null when the
  // directory does not exist, when brctl's download times out, or on any
  // unexpected error. Previously its return value was discarded and we fell
  // through to fs.readdir regardless, so a transient timeout produced a
  // PARTIAL listing served as a 200. The caller (sync/fromiCloud) then
  // treated every file missing from that partial list as deleted remotely
  // and removed Blot's local copy - silently unpublishing real posts.
  let listing = null;
  try {
    listing = await ls(dirPath);
  } catch (error) {
    console.error(clfdate(), "Error listing directory:", dirPath, error);
  }

  if (listing === null) {
    // Distinguish a directory that is genuinely gone (a legitimate remote
    // deletion - let it flow through the ENOENT -> 404 path below, as before)
    // from one that exists but whose contents iCloud has not materialised.
    // Only the latter is a partial listing, and for it we FAIL CLOSED: the
    // error makes remoteReaddir throw, which aborts that sync pass before its
    // deletion loop runs, and the sync is simply retried later. A failed sync
    // is recoverable; a deleted post is not.
    let exists = true;
    try {
      await fs.stat(dirPath);
    } catch (error) {
      if (error.code === "ENOENT") exists = false;
    }

    if (exists) {
      console.error(
        clfdate(),
        "Refusing to serve unconfirmed (possibly partial) listing:",
        dirPath
      );
      return res
        .status(503)
        .send("Directory listing unavailable: iCloud has not synced it yet");
    }
  }

  let files = [];

  try {
    // now that we are sure the directory is in sync, we can read it
    files = await fs.readdir(dirPath, { withFileTypes: true });
  } catch (error) {
    
    if (error.code === "ENOENT") {
      return res.status(404).send("Folder does not exist");
    }

    return res.status(500).send("Failed to read directory contents");
  }
  
  try {
    // Ignore system files and directories we don't want to sync
    const filteredFiles = files.filter((file) => !shouldIgnoreFile(file.name));

    const result = [];

    for (const file of filteredFiles) {
      try {
        const filePath = join(dirPath, file.name);
        const stat = await fs.stat(filePath);

        const modifiedTime = stat.mtime.toISOString();
        const size = stat.size;
        const isDirectory = file.isDirectory();

        result.push({
          name: file.name,
          isDirectory,
          size: isDirectory ? undefined : size,
          modifiedTime: isDirectory ? undefined : modifiedTime,
        });
      } catch (error) {
        // Don't let this error block the response, a file 
        // might have been deleted or moved since the
        // directory was listed

        if (error.code === "ENOENT") {
          continue;
        }

        console.error(clfdate(), "Failed to process file", {
          error,
        });
      }
    }

    console.log(clfdate(), `Readdir complete for blogID: ${blogID}, path: ${path}`);
    console.log(clfdate(), result);
    res.json(result);
  } catch (error) {
    console.error(clfdate(), "Failed to process directory contents", {
      dirPath,
      error,
    });
    res.status(500).send("Failed to process directory contents");
  }
};
