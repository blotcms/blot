const fs = require("fs-extra");
const { join } = require("path");
const localPath = require("helper/localPath");
const database = require("../database");
const download = require("../util/download");
const createDriveClient = require("../serviceAccount/createDriveClient");
const CheckWeCanContinue = require("../util/checkWeCanContinue");
const shouldIgnoreFile = require("clients/util/shouldIgnoreFile");
const {
  countLocalFiles,
  createProgress,
} = require("clients/util/resyncProgress");

const driveReaddir = require("./util/driveReaddir");
const localReaddir = require("./util/localReaddir");

const truncateToSecond = require("./util/truncateToSecond");
const transformDriveItems = require("./util/transformDriveItems");

module.exports = async function sync(blogID, publish, update) {
  publish = publish || function () {};
  update = update || function () {};

  const account = await database.blog.get(blogID);
  const { folderId, folderName, serviceAccountId } = account;

  if (!blogID) {
    throw new Error("Missing blogID required arguments for sync");
  }

  if (!serviceAccountId) {
    throw new Error("Missing required serviceAccountId for sync");
  }

  if (!folderId) {
    throw new Error("Missing required folderId for sync");
  }

  const drive = await createDriveClient(serviceAccountId);
  const { getByPath, set, remove } = database.folder(folderId);
  const checkWeCanContinue = CheckWeCanContinue(blogID, account);
  const progress = createProgress(
    await countLocalFiles(localPath(blogID, "/")),
    publish
  );

  // fetch the latest folderName, in case it has changed
  // and also whether or not the folder is in the trash
  try {
    const folder = await drive.files.get({
      fileId: folderId,
      supportsAllDrives: true,
      fields: "id, name, trashed",
    });

    if (folder.data.name !== folderName) {
      await database.blog.store(blogID, { folderName: folder.data.name });
    }

    if (folder.data.trashed) {
      publish("Error syncing with Google Drive");
      await database.blog.store(blogID, {
        error:
          "The Google Drive folder used to sync this site has been moved to the trash. Please select a new folder to continue syncing.",
        folderId: null,
        folderName: null,
      });
    }
  } catch (err) {
    if (err.code === 404) {
      publish("Error syncing with Google Drive");
      await database.blog.store(blogID, {
        error:
          "The Google Drive folder used to sync this site has been deleted. Please select a new folder to continue syncing.",
        folderId: null,
        folderName: null,
      });
    }
  }

  const walk = async (dir, dirId) => {
    if (!dir || !dirId) {
      throw new Error("Missing required arguments for walk");
    }

    // Ensure the dir is stored against the dirId
    await set(dirId, dir, { isDirectory: true });

    const [driveItems, localContents] = await Promise.all([
      driveReaddir(drive, dirId),
      localReaddir(localPath(blogID, dir)),
    ]);

    // We handle file name deduplication and the mapping of
    // google docs to .gdoc files here.
    const remoteContents = transformDriveItems(driveItems);

    for (const { name, isDirectory: isLocalDirectory } of localContents) {
      const path = join(dir, name);
      // A directory removed in one fs.remove call still accounts for every
      // file total counted inside it, so current must advance by that many.
      const removedCount = isLocalDirectory
        ? await countLocalFiles(localPath(blogID, path))
        : 1;

      if (shouldIgnoreFile(path)) {
        await checkWeCanContinue();
        progress.publish("Removing ignored", path, false, removedCount);
        await fs.remove(localPath(blogID, path));
        await update(path);
        const id = await getByPath(path);
        if (id) await remove(id);
        continue;
      }

      if (!remoteContents.find((item) => item.name === name)) {
        await checkWeCanContinue();
        progress.publish("Removing", path, false, removedCount);
        console.log(
          "Removing",
          join(dir, name),
          "which does not exist remotely"
        );
        await fs.remove(localPath(blogID, path));
        await update(path);
        await remove(await getByPath(path));
      }
    }

    // Add every new remote file in this directory to the total before
    // processing any of them, so progress reflects the real amount of work
    // discovered instead of total growing in lockstep with current.
    const newFileCount = remoteContents.filter(
      (item) =>
        !item.isDirectory &&
        !localContents.find((localItem) => localItem.name === item.name)
    ).length;
    progress.discover(newFileCount);

    for (const {
      id,
      name,
      isDirectory,
      size,
      modifiedTime,
      mimeType,
      md5Checksum,
    } of remoteContents) {
      const path = join(dir, name);
      const existsLocally = localContents.find((item) => item.name === name);

      if (!isDirectory) {
        // Ensure the file is stored in the database
        // any folders will be stored as they are walked
        await set(id, path, { isDirectory, modifiedTime });

        // These do not have a md5Checksum so we fall
        // back to using the modifiedTime
        const isGoogleAppFile = mimeType.startsWith(
          "application/vnd.google-apps."
        );

        const identical = isGoogleAppFile
          ? truncateToSecond(existsLocally?.modifiedTime) ===
            truncateToSecond(modifiedTime)
          : existsLocally?.size === size;

        if (!existsLocally || !identical) {
          await checkWeCanContinue();
          // A missing existsLocally was already added to total by the
          // discover() pass above; only a type mismatch (local dir where a
          // file is expected) is new work discovered here.
          progress.publish(
            "Downloading",
            path,
            Boolean(existsLocally && existsLocally.isDirectory)
          );

          if (existsLocally) {
            console.log("Updating out-of-sync:", path);
            console.log(
              "identical=false localSize=" + existsLocally.size,
              "remoteSize=" + size
            );
          } else {
            console.log("Downloading missing:", path);
          }

          try {
            const result = await download(
              blogID,
              drive,
              path,
              {
                id,
                md5Checksum,
                mimeType,
                modifiedTime,
              },
              {
                serviceAccountId,
                folderId,
              }
            );

            if (result?.skippedReason === "exportSizeLimitExceeded") {
              publish("Skipped oversized Google Doc", path);
            }

            if (result?.updated) await update(path);
          } catch (err) {
            publish("Download failed", path);
            console.error("Download failed for", path, err);
          }
        } else {
          progress.publishThrottled("Checking", path);
        }
      } else {
        if (existsLocally && !existsLocally.isDirectory) {
          await checkWeCanContinue();
          progress.publish("Removing file", path);
          console.log("Removing file", path, "which is a directory remotely");
          await fs.remove(localPath(blogID, path));
          publish("Creating directory", path);
          await fs.ensureDir(localPath(blogID, path));
          await update(path);
        } else if (!existsLocally) {
          await checkWeCanContinue();
          publish("Creating directory", path);
          console.log("Creating directory locally", path);
          await fs.ensureDir(localPath(blogID, path));
          await update(path);
        }

        await walk(path, id);
      }
    }
  };

  try {
    await walk("/", folderId);
    progress.finish("Finished processing folder");
  } catch (err) {
    publish("Sync failed", err.message);
  }
};
