import { join, resolve, sep } from "path";
import { iCloudDriveDirectory } from "../config.js";
import * as brctl from "../brctl/index.js";
import clfdate from "../util/clfdate.js";
import normalizeMacserverPath from "./normalizeMacserverPath.js";

export default async (req, res) => {
  const blogID = req.header("blogID");
  const path = Buffer.from(req.header("pathBase64"), "base64").toString("utf8");
  const normalizedPath = normalizeMacserverPath(path);

  if (!blogID || !path) {
    console.error(
      clfdate(),
      "Missing blogID or path header for download request",
      { blogID, path }
    );
    return res.status(400).send("Missing blogID or path header");
  }

  console.log(
    clfdate(),
    `Received download request for blogID: ${blogID}, path: ${path}`
  );

  try {
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

    // first download the file to make sure it's present on the local machine
    const stat = await brctl.download(filePath);

    // set the modifiedTime header to the file's modified time as an ISO string
    const modifiedTime = stat.mtime.toISOString();

    res.setHeader("modifiedTime", modifiedTime);
    res.download(filePath, normalizedPath, {
      // Explicitly permit serving dotfiles; by default, Express responds with a NotFoundError when a dotfile is requested. Blot syncs some dotfiles (see app/clients/util/shouldIgnoreFile.js) so we need to allow them.
      dotfiles: "allow",
    });
  } catch (err) {
    // handle ENOENT error
    if (err.code === "ENOENT") {
      console.error(clfdate(), "File not found:", err);
      return res.status(404).send("File not found");
    }

    console.error(clfdate(), "Failed to download file:", path, err);
    res.status(500).send("Failed to download file " + path);
  }
};
