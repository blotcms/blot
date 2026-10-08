const localPath = require("helper/localPath");
const establishSyncLock = require("sync/establishSyncLock");
const fs = require("fs-extra");
const { handleSyncLockError } = require("../lock");
const { handleRedisUnavailable } = require("../unavailable");
const { isRedisUnavailableError } = require("helper/redisUnavailable");
const shouldIgnoreFile = require("clients/util/shouldIgnoreFile");
const stampLastSync = require("./stampLastSync");

// If Redis cannot take the update, take the file we just wrote back off the
// disk. The macserver will push it again, and the upload route would
// otherwise find it already current and never build the entry. Removing it,
// rather than restoring what was there, also lets a resync notice the change:
// it compares sizes, which an edit can leave unchanged.
async function updateOrRollBack(folder, filePath, pathOnDisk) {
  try {
    await folder.update(filePath);
  } catch (err) {
    if (isRedisUnavailableError(err)) await fs.remove(pathOnDisk);
    throw err;
  }
}

module.exports = async function (req, res) {
  try {
    const blogID = req.header("blogID");
    const filePath = Buffer.from(req.header("pathBase64"), "base64").toString(
      "utf8"
    );
    const modifiedTime = req.header("modifiedTime");
    const isPlaceholderUpload = req.header("x-placeholder") === "true";
    const originalSizeHeader = req.header("x-original-size");
    const originalSize = Number(originalSizeHeader);

    // Validate required headers
    if (!blogID || !filePath) {
      console.warn("Missing required headers: blogID or path");
      return res.status(400).send("Missing required headers: blogID or path");
    }

    if (shouldIgnoreFile(filePath)) {
      return res.sendStatus(204);
    }

    await stampLastSync(blogID);

    const pathOnDisk = localPath(blogID, filePath);
    const incomingContents = isPlaceholderUpload
      ? Buffer.alloc(0)
      : Buffer.isBuffer(req.body)
      ? req.body
      : Buffer.from(req.body);

    const isFileAlreadyCurrent = async () => {
      if (!(await fs.pathExists(pathOnDisk))) {
        return false;
      }

      const existingContents = await fs.readFile(pathOnDisk);
      return existingContents.equals(incomingContents);
    };

    console.log(
      `Uploading binary file for blogID: ${blogID}, path: ${filePath}`
    );

    if (await isFileAlreadyCurrent()) {
      return res
        .status(200)
        .send(`File already up to date for blogID: ${blogID}`);
    }

    // Establish sync lock to allow safe file operations
    const { done, folder } = await establishSyncLock(blogID);

    try {
      if (await isFileAlreadyCurrent()) {
        return res
          .status(200)
          .send(`File already up to date for blogID: ${blogID}`);
      }

      if (isPlaceholderUpload) {
        folder.status("Saving placeholder " + filePath);

        await fs.outputFile(pathOnDisk, Buffer.alloc(0));

        await updateOrRollBack(folder, filePath, pathOnDisk);
        folder.status("Updated placeholder " + filePath);

        console.warn(
          `Placeholder created for oversized source file at: ${pathOnDisk}`,
          {
            blogID,
            filePath,
            originalSize,
            modifiedTime,
          }
        );

        return res
          .status(200)
          .send(`Placeholder created for oversized file for blogID: ${blogID}`);
      }

      folder.status("Saving " + filePath);

      // Ensure the directory exists and write the binary data to the file
      // Write the binary data (req.body is raw binary)
      await fs.outputFile(pathOnDisk, incomingContents);

      // Call the folder's update method to register the file change
      await updateOrRollBack(folder, filePath, pathOnDisk);

      // Set the folder status to reflect the upload action
      folder.status("Updated " + filePath);

      console.log(`File successfully written to: ${pathOnDisk}`);
      res.status(200).send(`File successfully uploaded for blogID: ${blogID}`);
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
        action: "upload",
      }) ||
      handleRedisUnavailable({
        err,
        res,
        blogID: req.header("blogID"),
        action: "upload",
      })
    ) {
      return;
    }

    console.error("Error in /upload:", err);
    res.status(500).send("Internal Server Error");
  }
};
