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
    // the cutoff (minus a grace period).
    modifiedDuringWalk: 0,
    // Subset of removed + createdDirs + downloaded: removals and new
    // directories have no modification time of their own, but creating,
    // removing or renaming an entry updates its parent directory's mtime, so
    // those in a directory modified at/after the cutoff (minus a grace
    // period) are most likely a live edit (e.g. a rename), not a change we
    // failed to sync. Renaming a directory touches neither its own mtime nor
    // its files', so everything the walk then creates or downloads inside a
    // directory it created that way is counted here too (a download already
    // counted in modifiedDuringWalk is not counted twice).
    changedDuringWalk: 0,
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

  // dirModifiedTime is the directory's own mtime, from its entry in its
  // parent's listing. The root has no such entry, so changes made directly
  // in the root are always counted. createdLive is true inside a directory
  // the walk created as part of a live edit: it was empty locally, so all
  // that the walk does in there belongs to that edit.
  const walk = async (dir, dirModifiedTime, createdLive = false) => {
    console.log(clfdate(), `Syncing folder: ${dir}`);
    const dirChangedDuringWalk = modifiedSince(dirModifiedTime, startedAt);
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
        // Not excused by dirChangedDuringWalk: this is Blot cleaning up a
        // file it should never have had, not a live edit in iCloud.
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
        if (dirChangedDuringWalk) summary.changedDuringWalk += 1;
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
        let walkedDirCreatedLive = false;
        if (existsLocally && !existsLocally.isDirectory) {
          await checkWeCanContinue();
          progress.publish("Removing", path);
          await fs.remove(localPath(blogID, path));
          summary.removed += 1;
          if (dirChangedDuringWalk) summary.changedDuringWalk += 1;
          publish("Creating directory", path);
          await fs.ensureDir(localPath(blogID, path));
          summary.createdDirs += 1;
          if (dirChangedDuringWalk || createdLive) {
            summary.changedDuringWalk += 1;
            walkedDirCreatedLive = true;
          }
          await update(path);
        } else if (!existsLocally) {
          await checkWeCanContinue();
          publish("Creating directory", path);
          await fs.ensureDir(localPath(blogID, path));
          summary.createdDirs += 1;
          if (dirChangedDuringWalk || createdLive) {
            summary.changedDuringWalk += 1;
            walkedDirCreatedLive = true;
          }
          await update(path);
        }

        await walk(path, modifiedTime, walkedDirCreatedLive);
      } else {
        // We could compare modified time but this seems to bug out on some sites
        const identicalOnRemote = existsLocally && existsLocally.size === size;

        // An oversized remote file is represented locally by an empty file.
        // The size never matches the remote's, so without this check every
        // walk would rewrite (and rebuild) every placeholder it made before.
        const placeholderInPlace =
          size > maxFileSize &&
          existsLocally &&
          !existsLocally.isDirectory &&
          existsLocally.size === 0;

        if (placeholderInPlace || identicalOnRemote) {
          progress.publishThrottled("Checking", path);
        } else {
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

              // Deliberately not counted as a missed change: a file Blot
              // can't sync anyway isn't worth an operator alert, and
              // counting it would need shared counting and template changes.
              try {
                let descendants = [];
                if (existsLocally && existsLocally.isDirectory) {
                  // A directory sits where the file belongs: clear it, and
                  // tell Blot about everything that was inside it.
                  descendants = await localDescendants(
                    localPath(blogID, path),
                    path
                  );
                  await fs.remove(localPath(blogID, path));
                }
                await fs.outputFile(localPath(blogID, path), "");
                summary.placeholdersCreated += 1;
                publish("Created placeholder for oversized file", path);
                // Register it, as the /upload placeholder route does, so the
                // entry is built (or rebuilt) from the empty file.
                await update(path);
                for (const descendant of descendants) await update(descendant);
              } catch (err) {
                publish("Failed to create placeholder", path, err.message);
                fail(err);
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
            } else if (createdLive) {
              summary.changedDuringWalk += 1;
            }
            await update(path);
          } catch (e) {
            publish("Failed to download", path, e);
            fail(e);
          }
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
