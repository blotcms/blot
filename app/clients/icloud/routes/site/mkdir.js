const localPath = require("helper/localPath");
const establishSyncLock = require("sync/establishSyncLock");
const fs = require("fs-extra");
const { handleSyncLockError } = require("../lock");
const { handleRedisUnavailable } = require("../unavailable");
const { isRedisUnavailableError } = require("helper/redisUnavailable");
const shouldIgnoreFile = require("clients/util/shouldIgnoreFile");
const stampLastSync = require("./stampLastSync");

module.exports = async function (req, res) {
  try {
    const blogID = req.header("blogID");
    const dirPath = Buffer.from(req.header("pathBase64"), "base64").toString(
      "utf8"
    );

    // Validate required headers
    if (!blogID || !dirPath) {
      return res.status(400).send("Missing required headers: blogID or path");
    }

    if (shouldIgnoreFile(dirPath)) {
      return res.sendStatus(204);
    }

    await stampLastSync(blogID);

    console.log(`Creating directory for blogID: ${blogID}, path: ${dirPath}`);

    const pathOnDisk = localPath(blogID, dirPath);
    const directoryExists = await fs.pathExists(pathOnDisk);

    if (directoryExists) {
      console.log(`Directory already exists at: ${pathOnDisk}`);
      return res.status(200).send("Directory already exists");
    }

    // Establish sync lock to allow safe file operations
    const { done, folder } = await establishSyncLock(blogID);

    try {
      const directoryExistsInLock = await fs.pathExists(pathOnDisk);

      console.log(`Creating directory at: ${pathOnDisk}`);

      if (!directoryExistsInLock) {
        // Ensure the directory exists
        await fs.ensureDir(pathOnDisk); // Creates the directory if it does not exist

        // Call the folder's update method to register the directory creation.
        // If Redis cannot take it, remove the directory again: the macserver
        // will ask again, and would be told it already exists.
        try {
          await folder.update(dirPath);
        } catch (err) {
          if (isRedisUnavailableError(err)) await fs.rmdir(pathOnDisk).catch(() => {});
          throw err;
        }

        // Set the folder status to reflect the mkdir action
        folder.status("Created " + dirPath);
      }

      console.log(`Directory successfully created: ${pathOnDisk}`);
      res
        .status(200)
        .send(`Directory successfully created for blogID: ${blogID}`);
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
        action: "mkdir",
      }) ||
      handleRedisUnavailable({
        err,
        res,
        blogID: req.header("blogID"),
        action: "mkdir",
      })
    ) {
      return;
    }

    console.error("Error in /mkdir:", err);
    res.status(500).send("Internal Server Error");
  }
};
