const establishSyncLock = require("sync/establishSyncLock");
const storage = require("storage/folder");
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

    if (!(await storage.exists(blogID, filePath))) {
      console.warn(`File not found (pre-lock): ${filePath}`);
      return res.sendStatus(204);
    }

    console.log(`Deleting file for blogID: ${blogID}, path: ${filePath}`);

    // Establish sync lock to allow safe file operations
    const { done, folder } = await establishSyncLock(blogID);

    try {
      if (!(await storage.exists(blogID, filePath))) {
        console.warn(`File not found (locked): ${filePath}`);
        return res.sendStatus(204);
      }

      console.log(`Deleting file at: ${filePath}`);

      const pathsToUpdate = [filePath];
      const stat = await storage.stat(blogID, filePath);

      if (stat.isDirectory) {
        // Directories before what is inside them
        for await (const childPath of storage.walk(blogID, filePath, {
          directories: true,
        })) {
          pathsToUpdate.push(childPath);
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
      await storage.remove(blogID, filePath); // Removes the file or directory

      // Call the folder's update method to register the file deletion
      for (const pathToUpdate of pathsToUpdate) {
        await folder.update(pathToUpdate);
        // Set the folder status to reflect the delete action
        folder.status("Removed " + pathToUpdate);
      }

      console.log(`Successfully deleted: ${filePath}`);
      return res.status(200).send(`Successfully deleted for blogID: ${blogID}`);
    } finally {
      // Release the sync lock
      await done().catch((err) => console.error("Error releasing lock:", err));
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
