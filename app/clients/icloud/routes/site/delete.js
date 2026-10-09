const localPath = require("helper/localPath");
const establishSyncLock = require("sync/establishSyncLock");
const fs = require("fs-extra");
const path = require("path");
const { handleSyncLockError } = require("../lock");
const { handleRedisUnavailable } = require("../unavailable");
const stampLastSync = require("./stampLastSync");

module.exports = async function (req, res) {
  try {
    const blogID = req.header("blogID");
    const filePath = Buffer.from(req.header("pathBase64"), "base64").toString(
      "utf8"
    );

    // Validate required headers
    if (!blogID || !filePath) {
      return res.status(400).send("Missing required headers: blogID or path");
    }

    await stampLastSync(blogID);

    // Compute the local file path on disk before taking the lock
    const pathOnDisk = localPath(blogID, filePath);

    if (!(await fs.pathExists(pathOnDisk))) {
      console.warn(`File not found (pre-lock): ${filePath}`);
      return res.sendStatus(204);
    }

    console.log(`Deleting file for blogID: ${blogID}, path: ${filePath}`);

    // Establish sync lock to allow safe file operations
    const { done, folder } = await establishSyncLock(blogID);

    try {
      if (!(await fs.pathExists(pathOnDisk))) {
        console.warn(`File not found (locked): ${filePath}`);
        return res.sendStatus(204);
      }

      console.log(`Deleting file at: ${pathOnDisk}`);

      const pathsToUpdate = [filePath];
      const stat = await fs.lstat(pathOnDisk);

      if (stat.isDirectory()) {
        const collectChildPaths = async (directoryPath) => {
          const entries = await fs.readdir(directoryPath, { withFileTypes: true });
          const childPaths = [];

          for (const entry of entries) {
            const entryPath = path.join(directoryPath, entry.name);
            childPaths.push(entryPath);

            if (entry.isDirectory()) {
              childPaths.push(...(await collectChildPaths(entryPath)));
            }
          }

          return childPaths;
        };

        const childPathsOnDisk = await collectChildPaths(pathOnDisk);

        for (const childPathOnDisk of childPathsOnDisk) {
          const relativeChildPath = path.join(
            filePath,
            path.relative(pathOnDisk, childPathOnDisk)
          );
          pathsToUpdate.push(relativeChildPath);
        }

        console.log(
          `Folder delete will update ${pathsToUpdate.length} paths for ${filePath}`
        );
      }

      // The file is removed before Blot's entries are updated. If Redis
      // refuses the update the route answers 503, but the file is already
      // gone, so the macserver's retry is told there is nothing to delete and
      // the entries (for a folder, those of the files inside it) stay until a
      // resync or Fix(). Accepted: it needs Redis to fail in the middle of a delete.
      await fs.remove(pathOnDisk); // Removes the file or directory

      // Call the folder's update method to register the file deletion
      for (const pathToUpdate of pathsToUpdate) {
        await folder.update(pathToUpdate);
        // Set the folder status to reflect the delete action
        folder.status("Removed " + pathToUpdate);
      }

      console.log(`Successfully deleted: ${pathOnDisk}`);
      return res.status(200).send(`Successfully deleted for blogID: ${blogID}`);
    } finally {
      // Release the sync lock
      done().catch((err) => console.error("Error releasing lock:", err));
    }
  } catch (err) {
    if (
      handleSyncLockError({
        err,
        res,
        blogID: req.header("blogID"),
        action: "delete",
      }) ||
      handleRedisUnavailable({
        err,
        res,
        blogID: req.header("blogID"),
        action: "delete",
      })
    ) {
      return;
    }

    console.error("Error in /delete:", err);
    res.status(500).send("Internal Server Error");
  }
};
