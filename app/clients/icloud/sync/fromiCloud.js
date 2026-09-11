const fs = require("fs-extra");
const { join } = require("path");
const localPath = require("helper/localPath");
const clfdate = require("helper/clfdate");
const download = require("./util/download");
const CheckWeCanContinue = require("./util/checkWeCanContinue");
const localReaddir = require("./util/localReaddir");
const remoteReaddir = require("./util/remoteReaddir");
const remoteRecursiveList = require("./util/remoteRecursiveList");
const shouldIgnoreFile = require("clients/util/shouldIgnoreFile");
const {
  countLocalFiles,
  createProgress,
} = require("clients/util/resyncProgress");

const database = require("../database");
const config = require("config");
const maxFileSize = config.icloud.maxFileSize; // Maximum file size for iCloud uploads in bytes

module.exports = async (blogID, publish, update) => {
  if (!publish)
    publish = (...args) => {
      console.log(clfdate() + " iCloud:", args.join(" "));
    };

  if (!update) update = () => {};

  const checkWeCanContinue = CheckWeCanContinue(blogID);
  const progress = createProgress(
    await countLocalFiles(localPath(blogID, "/")),
    publish
  );
  const summary = {
    downloaded: 0,
    removed: 0,
    createdDirs: 0,
    skipped: 0,
    placeholdersCreated: 0,
  };

  try {
    publish("Syncing folder tree");
    await remoteRecursiveList(blogID, "/");
    publish("Synced folder tree");
  } catch (error) {
    console.error("Failed to sync folder tree", {
      error,
    });
    publish("Failed to sync folder tree");
  }

  const walk = async (dir) => {
    console.log(clfdate(), `Syncing folder: ${dir}`);
    const [remoteContents, localContents] = await Promise.all([
      remoteReaddir(blogID, dir),
      localReaddir(localPath(blogID, dir)),
    ]);

    for (const { name, isDirectory: isLocalDirectory } of localContents) {
      const path = join(dir, name);
      // A directory removed in one fs.remove call still accounts for every
      // file total counted inside it, so current must advance by that many.
      const removedCount = isLocalDirectory
        ? await countLocalFiles(localPath(blogID, path))
        : 1;

      if (shouldIgnoreFile(path)) {
        await checkWeCanContinue();
        progress.publish(
          "Removing local ignored item",
          path,
          false,
          removedCount
        );
        await fs.remove(localPath(blogID, path));
        summary.removed += 1;
        await update(path);
        continue;
      }

      if (
        !remoteContents.find(
          (item) => item.name.normalize("NFC") === name.normalize("NFC")
        )
      ) {
        await checkWeCanContinue();
        progress.publish("Removing local item", path, false, removedCount);
        await fs.remove(localPath(blogID, path));
        summary.removed += 1;
        await update(path);
      }
    }

    // Add every new remote file in this directory to the total before
    // processing any of them, so progress reflects the real amount of work
    // discovered instead of total growing in lockstep with current.
    const newFileCount = remoteContents.filter(
      (item) =>
        !item.isDirectory &&
        !localContents.find(
          (localItem) =>
            localItem.name.normalize("NFC") === item.name.normalize("NFC")
        )
    ).length;
    progress.discover(newFileCount);

    for (const { name, size, isDirectory } of remoteContents) {
      const path = join(dir, name);
      const existsLocally = localContents.find(
        (item) => item.name.normalize("NFC") === name.normalize("NFC")
      );

      if (isDirectory) {
        if (existsLocally && !existsLocally.isDirectory) {
          await checkWeCanContinue();
          progress.publish("Removing", path);
          await fs.remove(localPath(blogID, path));
          summary.removed += 1;
          publish("Creating directory", path);
          await fs.ensureDir(localPath(blogID, path));
          summary.createdDirs += 1;
          await update(path);
        } else if (!existsLocally) {
          await checkWeCanContinue();
          publish("Creating directory", path);
          await fs.ensureDir(localPath(blogID, path));
          summary.createdDirs += 1;
          await update(path);
        }

        await walk(path);
      } else {
        // We could compare modified time but this seems to bug out on some sites
        const identicalOnRemote = existsLocally && existsLocally.size === size;

        if (!existsLocally || (existsLocally && !identicalOnRemote)) {
          try {
            if (size > maxFileSize) {
              // A missing existsLocally was already added to total by the
              // discover() pass above; only a type mismatch (local dir
              // where a file is expected) is new work discovered here.
              progress.publish(
                "File too large",
                `${path} (${size} bytes > ${maxFileSize} byte limit)`,
                Boolean(existsLocally && existsLocally.isDirectory)
              );
              summary.skipped += 1;

              try {
                await fs.outputFile(localPath(blogID, path), "");
                summary.placeholdersCreated += 1;
                publish("Created placeholder for oversized file", path);
              } catch (err) {
                publish("Failed to create placeholder", path, err.message);
              }

              continue;
            }

            await checkWeCanContinue();
            progress.publish(
              "Downloading",
              path,
              Boolean(existsLocally && existsLocally.isDirectory)
            );

            await download(blogID, path);
            summary.downloaded += 1;
            await update(path);
          } catch (e) {
            publish("Failed to download", path, e);
          }
        } else {
          progress.publishThrottled("Checking", path);
        }
      }
    }
  };

  try {
    await walk("/");
    progress.finish("Finished processing folder");
    // update the database to remove the error flag if it exists
    await database.store(blogID, { error: null });
  } catch (err) {
    publish("Sync failed", err.message);
    // Possibly rethrow or handle
  }

  return summary;
};
