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
const modifiedSince = require("clients/util/modifiedSince");
const localDescendants = require("clients/util/localDescendants");
const {
  countLocalFiles,
  createProgress,
} = require("clients/util/resyncProgress");

const database = require("../database");
const health = require("clients/health");
const { resolveCode } = require("../error");
const config = require("config");
const maxFileSize = config.icloud.maxFileSize; // Maximum file size for iCloud uploads in bytes

// The walk removes every local item the remote listing doesn't have, so a
// listing that comes back empty or truncated (macserver restarting, iCloud
// not having materialised the folder yet) would wipe the folder. Refuse to
// remove more than REMOVAL_FLOOR files from one directory in one walk when
// that is also more than MAX_REMOVAL_SHARE of the directory's local entries:
// a real cleanup of a few files passes either way, and a user who genuinely
// deletes most of a large folder gets an error in the sweep's digest and can
// resync from the dashboard after checking, instead of silently losing it.
const REMOVAL_FLOOR = 20;
const MAX_REMOVAL_SHARE = 0.5;

module.exports = async (blogID, publish, update) => {
  if (!publish)
    publish = (...args) => {
      console.log(clfdate() + " iCloud:", args.join(" "));
    };

  if (!update) update = () => {};

  // Files modified in iCloud after this moment may just be edits that
  // landed mid-walk, not changes we failed to sync. Callers hold the folder
  // lock, so this is (just after) when it was acquired.
  const startedAt = Date.now();

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
    // Subset of downloaded: files the macserver reports modified at/after
    // the cutoff (minus a grace period). Directories and removals have no
    // modification time to check here, so only downloads are excluded.
    modifiedDuringWalk: 0,
    // Failures the walk swallows (it carries on or stops quietly rather than
    // throwing), so a caller that must not mistake an unreachable macserver
    // for "nothing changed" can tell: how many, and the first one's message.
    // Other callers (resync, /status) ignore these.
    failed: 0,
    firstError: null,
  };

  const fail = (error) => {
    summary.failed += 1;
    if (!summary.firstError) {
      summary.firstError = String((error && error.message) || error);
    }
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
    fail(error);
  }

  const walk = async (dir) => {
    console.log(clfdate(), `Syncing folder: ${dir}`);
    const [remoteContents, localContents] = await Promise.all([
      remoteReaddir(blogID, dir),
      localReaddir(localPath(blogID, dir)),
    ]);

    // A directory removed in one fs.remove call still accounts for every
    // file total counted inside it, so current must advance by that many.
    // Kept by local item name for the removal pass below, which also totals
    // what the remote listing is missing for the mass-removal check.
    const removedCounts = new Map();
    let missingEntries = 0;
    let missingFiles = 0;

    for (const { name, isDirectory: isLocalDirectory } of localContents) {
      const path = join(dir, name);
      const removedCount = isLocalDirectory
        ? await countLocalFiles(localPath(blogID, path))
        : 1;
      removedCounts.set(name, removedCount);

      if (
        !shouldIgnoreFile(path) &&
        !remoteContents.find(
          (item) => item.name.normalize("NFC") === name.normalize("NFC")
        )
      ) {
        missingEntries += 1;
        missingFiles += removedCount;
      }
    }

    // Throws before anything in this directory is removed. The walk's catch
    // below turns it into summary.failed, so the sweep reports it.
    if (
      missingFiles > REMOVAL_FLOOR &&
      missingEntries > localContents.length * MAX_REMOVAL_SHARE
    ) {
      throw new Error(
        `Refusing to remove ${missingFiles} files (${missingEntries} of ` +
          `${localContents.length} items) from ${dir}: iCloud's listing ` +
          "looks incomplete"
      );
    }

    for (const { name, isDirectory: isLocalDirectory } of localContents) {
      const path = join(dir, name);
      const removedCount = removedCounts.get(name);

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
        const descendants = isLocalDirectory
          ? await localDescendants(localPath(blogID, path), path)
          : [];
        await fs.remove(localPath(blogID, path));
        summary.removed += 1;
        await update(path);
        for (const descendant of descendants) await update(descendant);
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

    for (const { name, size, isDirectory, modifiedTime } of remoteContents) {
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
            if (modifiedSince(modifiedTime, startedAt)) {
              summary.modifiedDuringWalk += 1;
            }
            await update(path);
          } catch (e) {
            publish("Failed to download", path, e);
            fail(e);
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
    // A successful walk means the shared folder exists. Only clear a stored
    // error after setup is complete: otherwise a later fromiCloud pass can
    // wipe a failed initial transfer and leave the blog looking healthy
    // while setupComplete is still false. Leave an error recorded after the
    // walk began (the watcher can report the folder deleted mid-walk, and
    // per-file failures above are swallowed), and SOURCE_MISSING always: the
    // watcher stops watching a deleted folder, so only setup recovers it.
    const account = await database.get(blogID);
    if (
      account &&
      account.setupComplete &&
      account.error &&
      resolveCode(account) !== health.CODES.SOURCE_MISSING &&
      !(typeof account.errorSince === "number" && account.errorSince >= startedAt)
    ) {
      await database.store(blogID, { error: null });
    }
  } catch (err) {
    publish("Sync failed", err.message);
    fail(err);
    // Not rethrown: callers rely on getting the partial summary back.
  }

  return summary;
};
