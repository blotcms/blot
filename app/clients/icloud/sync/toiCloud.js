const { join } = require("path");
const clfdate = require("helper/clfdate");
const CheckWeCanContinue = require("./util/checkWeCanContinue");
const remoteUpload = require("./util/remoteUpload");
const remoteMkdir = require("./util/remoteMkdir");
const remoteDelete = require("./util/remoteDelete");
const localReaddir = require("./util/localReaddir");
const remoteReaddir = require("./util/remoteReaddir");

const config = require("config");
const maxFileSize = config.icloud.maxFileSize; // Maximum file size for iCloud uploads in bytes

const prefix = () => `${clfdate()} iCloud Sync to iCloud:`;

// Retry failed operations with exponential backoff
async function retry(fn, ...args) {
  for (let i = 0; i < 3; i++) {
    try {
      return await fn(...args);
    } catch (e) {
      if (i === 2) throw e;
      const delay = Math.min(1000 * Math.pow(2, i), 10000);
      console.log("Attempt", i ,"failed, retrying in", delay, "ms", e);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}


module.exports = async (blogID, publish, update, { skipDeletions = false, abortOnError = false, skipEmptyFiles = false } = {}) => {
  publish = publish || function () {};
  update = update || function () {};

  const checkWeCanContinue = CheckWeCanContinue(blogID);

  let skippedEmpty = 0;

  const walk = async (dir) => {
    const [remoteContents, localContents] = await Promise.all([
      remoteReaddir(blogID, dir),
      localReaddir(blogID, dir),
    ]);

    for (const { name } of remoteContents) {
      const localItem = localContents.find(
        (item) => item.name.normalize("NFC") === name.normalize("NFC")
      );

      if (!localItem && !skipDeletions) {
        const path = join(dir, name);
        await checkWeCanContinue();
        publish("Removing from iCloud", join(dir, name));
        try {
          await retry(remoteDelete, blogID, path);
        } catch (e) {
          publish("Failed to remove", path);
          console.log(prefix(), "Failed to remove", path, e);
          if (abortOnError) throw e;
        }
      }
    }

    for (const { name, size, isDirectory } of localContents) {
      const path = join(dir, name);
      const remoteItem = remoteContents.find(
        (item) => item.name.normalize("NFC") === name.normalize("NFC")
      );

      if (isDirectory) {
        if (!remoteItem || (remoteItem && !remoteItem.isDirectory)) {
          await checkWeCanContinue();
          publish("Creating directory in iCloud", path);
          try {
            await retry(remoteMkdir, blogID, path);
          } catch (e) {
            publish("Failed to create directory", path);
            console.log(prefix(), "Failed to create directory", path, e);
            if (abortOnError) throw e;
            continue;
          }
        }

        await walk(path);
      } else {
        // Blot writes an empty file where it could not download a file
        // (oversized files), so a placeholder is indistinguishable from a
        // file that really is empty. During the initial transfer we never
        // upload empty files, which would put an empty file in iCloud or
        // overwrite the real file already there. The cost is that genuinely
        // empty files do not carry over to iCloud.
        if (skipEmptyFiles && size === 0) {
          console.log(
            prefix(),
            "Skipping empty file (possible placeholder)",
            blogID,
            path
          );
          skippedEmpty += 1;
          continue;
        }

        const identicalOnRemote = remoteItem && remoteItem.size === size;

        if (!remoteItem || !identicalOnRemote) {
          await checkWeCanContinue();
          if (size > maxFileSize) {
            publish("Skipping file which is too large", path);
            console.log(prefix(), "Skipping file size=" + size, path);
            // it's important to throw an error here to prevent data loss
            // down the line, if the assumpation after this process runs
            // is that the folders are in sync between Blot and iCloud.
            if (abortOnError) throw new Error("File is too large: " + path);
            continue;
          }
          publish("Transferring to iCloud", path);
          try {
            await retry(remoteUpload, blogID, path);
          } catch (e) {
            publish("Failed to upload", path, e);
            console.log(prefix(), "Failed to upload", path, e);
            if (abortOnError) throw e;
          }
        }
      }
    }
  };

  try {
    await walk("/");
    if (skippedEmpty > 0) {
      publish(
        "Skipped " +
          skippedEmpty +
          " empty file" +
          (skippedEmpty === 1 ? "" : "s") +
          " (possible placeholders for files Blot could not download)"
      );
    }
    publish("Sync complete");
  } catch (e) {
    publish("Sync failed");
    console.log(prefix(), "Sync failed", e);
    if (abortOnError) throw e;
  }
};
