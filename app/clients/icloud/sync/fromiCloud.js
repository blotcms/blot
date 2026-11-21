const { join } = require("path");
const folder = require("storage/folder");
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
const createDownloadLimiter = require("./util/downloadLimiter");

// How many files the walk downloads at once. One at a time, reconnecting a
// folder of 308 small files took about 4.5 minutes (1 to 2.5 files a
// second), mostly waiting on the macserver. Every request to the macserver
// from this process shares one limiter (5 at once, one starting every 200ms,
// util/rateLimitedFetchWithRetriesAndTimeout.js), and the macserver may run
// `brctl download` for each evicted file before it answers, so 4 leaves room
// for other blogs' requests and doesn't pile work on the macserver.
const DOWNLOAD_CONCURRENCY = 4;

// download() holds each file in memory until it is written, so files run
// side by side only while their sizes add up to no more than this. A larger
// file (up to maxFileSize) downloads on its own.
const MAX_DOWNLOAD_BYTES_IN_FLIGHT = 32 * 1000 * 1000;

// The macserver answers the folder tree listing only once it has listed the
// whole folder (about 22s for a few hundred files), so say it's still going.
const LISTING_HEARTBEAT_SECONDS = 5;

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
  const progress = createProgress(await countLocalFiles(blogID, "/"), publish);
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

  let listingSeconds = 0;
  const listingHeartbeat = setInterval(() => {
    listingSeconds += LISTING_HEARTBEAT_SECONDS;
    publish(`Syncing folder tree (${listingSeconds}s)`);
  }, LISTING_HEARTBEAT_SECONDS * 1000);
  if (listingHeartbeat.unref) listingHeartbeat.unref();

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
  } finally {
    clearInterval(listingHeartbeat);
  }

  // Shared by every directory of the walk, so a tree of small directories
  // downloads several files at once too
  const limitDownload = createDownloadLimiter({
    maxConcurrent: DOWNLOAD_CONCURRENCY,
    maxBytes: MAX_DOWNLOAD_BYTES_IN_FLIGHT,
  });

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
      localReaddir(blogID, dir),
    ]);

    for (const { name, isDirectory: isLocalDirectory } of localContents) {
      const path = join(dir, name);
      // A directory removed in one remove call still accounts for every
      // file total counted inside it, so current must advance by that many.
      const removedCount = isLocalDirectory
        ? await countLocalFiles(blogID, path)
        : 1;

      if (shouldIgnoreFile(path)) {
        await checkWeCanContinue();
        progress.publish(
          "Removing local ignored item",
          path,
          false,
          removedCount
        );
        await folder.remove(blogID, path);
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
          ? await localDescendants(blogID, path)
          : [];
        await folder.remove(blogID, path);
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

    // Start this directory's downloads (a few at a time, see
    // DOWNLOAD_CONCURRENCY) before the loop below, which goes through the
    // entries in order and applies each result: the summary, update() and
    // the messages for each file still happen one file at a time, in order.
    // The removals above are done by now, and this directory exists locally
    // (walk() is called once it is created). Oversized files, and files with
    // a local directory in their way, are left to the loop as before.
    let stopped = false;
    const downloads = [];
    const started = new Map();

    for (const { name, size, isDirectory } of remoteContents) {
      if (isDirectory || size > maxFileSize) continue;
      const path = join(dir, name);
      const existsLocally = localContents.find(
        (item) => item.name.normalize("NFC") === name.normalize("NFC")
      );
      if (existsLocally && existsLocally.isDirectory) continue;

      // We could compare modified time but this seems to bug out on some sites
      // A placeholder isn't identical to a file which is now really empty
      const identicalOnRemote =
        existsLocally &&
        existsLocally.size === size &&
        !(size === 0 && (await folder.isPlaceholder(blogID, path)));
      if (identicalOnRemote) continue;

      // Never rejects: resolves with the error, or with stop once the walk
      // of this directory is over
      const pending = limitDownload(size, async () => {
        if (stopped) return { stop: true };
        try {
          await checkWeCanContinue();
          progress.publish("Downloading", path, false);
          await download(blogID, path);
          return {};
        } catch (error) {
          return { error };
        }
      });
      downloads.push(pending);
      started.set(path, pending);
    }

    try {
      await applyRemoteContents(
        dir,
        remoteContents,
        localContents,
        dirChangedDuringWalk,
        createdLive,
        started
      );
    } finally {
      // Downloads not started yet must not start now, and those running
      // write into the blog folder: wait for them before the walk returns or
      // rethrows, so none writes after the folder lock is released
      stopped = true;
      await Promise.all(downloads);
    }
  };

  const applyRemoteContents = async (
    dir,
    remoteContents,
    localContents,
    dirChangedDuringWalk,
    createdLive,
    started
  ) => {
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
          await folder.remove(blogID, path);
          summary.removed += 1;
          if (dirChangedDuringWalk) summary.changedDuringWalk += 1;
          progress.note("Creating directory", path);
          await folder.mkdir(blogID, path);
          summary.createdDirs += 1;
          if (dirChangedDuringWalk || createdLive) {
            summary.changedDuringWalk += 1;
            walkedDirCreatedLive = true;
          }
          await update(path);
        } else if (!existsLocally) {
          await checkWeCanContinue();
          progress.note("Creating directory", path);
          await folder.mkdir(blogID, path);
          summary.createdDirs += 1;
          if (dirChangedDuringWalk || createdLive) {
            summary.changedDuringWalk += 1;
            walkedDirCreatedLive = true;
          }
          await update(path);
        }

        await walk(path, modifiedTime, walkedDirCreatedLive);
      } else if (started.has(path)) {
        // Started above, and done by now or still running: applied here, in
        // order. A failed check that we can continue fails just this file,
        // as it did when the download ran here.
        const outcome = await started.get(path);
        try {
          if (outcome.error) throw outcome.error;
          summary.downloaded += 1;
          if (modifiedSince(modifiedTime, startedAt)) {
            summary.modifiedDuringWalk += 1;
          } else if (createdLive) {
            summary.changedDuringWalk += 1;
          }
          await update(path);
        } catch (e) {
          progress.note("Failed to download", path, e);
          fail(e);
        }
      } else {
        // We could compare modified time but this seems to bug out on some sites
        // A placeholder isn't identical to a file which is now really empty
        const identicalOnRemote =
          existsLocally &&
          existsLocally.size === size &&
          !(size === 0 && (await folder.isPlaceholder(blogID, path)));

        // An oversized remote file is represented locally by an empty file.
        // The size never matches the remote's, so without this check every
        // walk would rewrite (and rebuild) every placeholder it made before.
        const placeholderInPlace =
          size > maxFileSize &&
          existsLocally &&
          !existsLocally.isDirectory &&
          existsLocally.size === 0;

        if (placeholderInPlace) {
          progress.publishThrottled("Checking", path);

          // One written before placeholders were flagged is flagged now, so
          // it isn't taken for a file which really is empty
          const placeholder = await folder.stat(blogID, path);
          if (!placeholder.placeholder) {
            await folder.setFlags(blogID, path, "sync", [
              { code: "SYNC_TOO_LARGE", size: size, limit: maxFileSize },
            ]);
          }
        } else if (identicalOnRemote) {
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
              // can't sync anyway isn't worth a maintainer alert, and
              // counting it would need shared counting and template changes.
              try {
                let descendants = [];
                if (existsLocally && existsLocally.isDirectory) {
                  // A directory sits where the file belongs: clear it, and
                  // tell Blot about everything that was inside it.
                  descendants = await localDescendants(blogID, path);
                  await folder.remove(blogID, path);
                }
                await folder.writePlaceholder(blogID, path, {
                  code: "SYNC_TOO_LARGE",
                  size: size,
                  limit: maxFileSize,
                });
                summary.placeholdersCreated += 1;
                progress.note("Created placeholder for oversized file", path);
                // Register it, as the /upload placeholder route does, so an
                // entry built from the old bytes is dropped.
                await update(path);
                for (const descendant of descendants) await update(descendant);
              } catch (err) {
                progress.note(
                  "Failed to create placeholder",
                  path,
                  err.message
                );
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
            progress.note("Failed to download", path, e);
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
      !(
        typeof account.errorSince === "number" &&
        account.errorSince >= startedAt
      )
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
