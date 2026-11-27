import fs from "fs-extra";
import { join, resolve, sep } from "path";
import { rootOf } from "../blogFolder.js";
import clfdate from "../util/clfdate.js";
import normalizeMacserverPath from "./normalizeMacserverPath.js";
import { expectBlotChange } from "../blotWrites.js";
import { forgetPath } from "../pushedFiles.js";

export default async (req, res) => {
  const blogID = req.header("blogID");
  const path = Buffer.from(req.header("pathBase64"), "base64").toString("utf8");
  const normalizedPath = normalizeMacserverPath(path);

  // Validate required headers
  if (!blogID || !path) {
    console.error(clfdate(), "Missing required headers for delete request", {
      blogID,
      path,
    });
    return res.status(400).send("Missing required headers: blogID or path");
  }

  console.log(
    clfdate(),
    `Received delete request for blogID: ${blogID}, path: ${path}`
  );

  const basePath = resolve(rootOf(blogID));
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

  // The watcher keeps running (see blotWrites.js). Its removal event is
  // Blot's own; the path is forgotten so the file is pushed again if it comes
  // back with the same size and mtime.
  forgetPath(blogID, normalizedPath);
  expectBlotChange(blogID, normalizedPath, "remove");

  for (let i = 0; i < 10; i++) {
    try {
      await fs.remove(filePath);
      console.log(clfdate(), `Deleted file: ${filePath}`);
      return res.sendStatus(200);
    } catch (error) {
      console.error(clfdate(), `Failed to delete file (${filePath}):`, error);
      await new Promise((resolve) => setTimeout(resolve, 1000 * i)); // Exponential backoff
    }
  }

  return res.status(500).send("Failed to delete file after retries");
};
