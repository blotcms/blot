const { join } = require("path");
const clfdate = require("helper/clfdate");
const CheckWeCanContinue = require("./util/checkWeCanContinue");
const remoteUpload = require("./util/remoteUpload");
const remoteMkdir = require("./util/remoteMkdir");
const remoteDelete = require("./util/remoteDelete");
const localReaddir = require("./util/localReaddir");
const remoteReaddir = require("./util/remoteReaddir");
const folder = require("storage/folder");
const {
  countLocalFiles,
  createProgress,
} = require("clients/util/resyncProgress");

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
      console.log("Attempt", i, "failed, retrying in", delay, "ms", e);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

module.exports = async (
  blogID,
  publish,
  update,
  { skipDeletions = false, abortOnError = false } = {}
) => {
  publish = publish || function () {};

  const checkWeCanContinue = CheckWeCanContinue(blogID);

  let skippedPlaceholders = 0;

  // Messages carry the count ("(12/340) Transferring to iCloud /a.txt"),
  // which the dashboard's status line shows as a progress bar. Every local
  // file advances it, copied or not, so it ends at the total however many
  // files iCloud already had
  const progress = createProgress(
    await countLocalFiles(blogID, "/").catch(() => 0),
    publish
  );

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
        progress.note("Removing from iCloud", path);
        try {
          await retry(remoteDelete, blogID, path);
        } catch (e) {
          progress.note("Failed to remove", path);
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
          progress.note("Creating directory in iCloud", path);
          try {
            await retry(remoteMkdir, blogID, path);
          } catch (e) {
            progress.note("Failed to create directory", path);
            console.log(prefix(), "Failed to create directory", path, e);
            if (abortOnError) throw e;
            continue;
          }
        }

        await walk(path);
      } else {
        // An empty file may be a placeholder Blot wrote for a file it could
        // not download (an oversized one). Its bytes aren't the file's, so
        // it is never uploaded. A file which really is empty is uploaded,
        // unless iCloud already has a file there with bytes: an empty file
        // never overwrites one.
        if (size === 0) {
          if (await folder.isPlaceholder(blogID, path)) {
            console.log(prefix(), "Skipping placeholder", blogID, path);
            skippedPlaceholders += 1;
            progress.publishThrottled("Checking", path);
            continue;
          }

          if (remoteItem && !remoteItem.isDirectory && remoteItem.size > 0) {
            console.log(
              prefix(),
              "Not overwriting a file in iCloud with an empty one",
              blogID,
              path
            );
            progress.publishThrottled("Checking", path);
            continue;
          }
        }

        const identicalOnRemote = remoteItem && remoteItem.size === size;

        if (!remoteItem || !identicalOnRemote) {
          await checkWeCanContinue();
          if (size > maxFileSize) {
            progress.publish("Skipping file which is too large", path);
            console.log(prefix(), "Skipping file size=" + size, path);
            // it's important to throw an error here to prevent data loss
            // down the line, if the assumpation after this process runs
            // is that the folders are in sync between Blot and iCloud.
            if (abortOnError) throw new Error("File is too large: " + path);
            continue;
          }
          progress.publish("Transferring to iCloud", path);
          try {
            await retry(remoteUpload, blogID, path);
          } catch (e) {
            progress.note("Failed to upload", path, e);
            console.log(prefix(), "Failed to upload", path, e);
            if (abortOnError) throw e;
          }
        } else {
          progress.publishThrottled("Checking", path);
        }
      }
    }
  };

  try {
    await walk("/");
    if (skippedPlaceholders > 0) {
      progress.note(
        "Skipped " +
          skippedPlaceholders +
          " placeholder" +
          (skippedPlaceholders === 1 ? "" : "s") +
          " for files Blot could not download"
      );
    }
    progress.finish("Sync complete");
  } catch (e) {
    publish("Sync failed");
    console.log(prefix(), "Sync failed", e);
    if (abortOnError) throw e;
  }
};
