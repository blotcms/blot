const migrationBudget = require("./util/migrationBudget");
const comparePaths = require("./util/comparePaths");
const fs = require("fs-extra");
const { join } = require("path");
const localPath = require("helper/localPath");
const database = require("../database");
const {
  MESSAGES,
  isLostFolderError,
  lostFolderMessage,
  sourceMissingFields,
} = require("../database/error");
const download = require("../util/download");
const localFingerprint = require("../util/localFingerprint");
const createDriveClient = require("../serviceAccount/createDriveClient");
const CheckWeCanContinue = require("../util/checkWeCanContinue");
const shouldIgnoreFile = require("clients/util/shouldIgnoreFile");
const modifiedSince = require("clients/util/modifiedSince");
const {
  countLocalFiles,
  createProgress,
} = require("clients/util/resyncProgress");

const driveReaddir = require("./util/driveReaddir");
const localReaddir = require("./util/localReaddir");

const truncateToSecond = require("./util/truncateToSecond");
const transformDriveItems = require("./util/transformDriveItems");

const SHORTCUT = "application/vnd.google-apps.shortcut";

// Resolves to a summary of what changed (truthy) when the walk finishes, or
// false when it fails part way through or the folder lookup fails.
module.exports = async function sync(blogID, publish, update, options = {}) {
  publish = publish || function () {};
  update = update || function () {};

  // Files Drive modified after this moment may just be edits that landed
  // mid-walk, not changes we failed to sync. Callers hold the folder lock,
  // so this is (just after) when it was acquired.
  const startedAt = Date.now();
  const summary = {
    downloaded: 0,
    removed: 0,
    createdDirs: 0,
    modifiedDuringWalk: 0,
  };

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
  const { getByPath, getApplied, setApplied, set, remove, getVerifiedContents, setVerifiedContent,
    getMigrationCursor, setMigrationCursor } = database.folder(folderId, blogID);
  const migrationCursor = await getMigrationCursor();
  const canMigrate = migrationBudget();
  let lastMigrated = migrationCursor;
  let migrationExhausted = false;
  let deferred = 0;
  const checkWeCanContinue = CheckWeCanContinue(blogID, account);
  const progress = createProgress(
    await countLocalFiles(localPath(blogID, "/")),
    publish
  );

  const markSourceMissing = async (message) => {
    publish("Error syncing with Google Drive");
    await database.blog.store(blogID, sourceMissingFields(account, message));
    return false;
  };

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

    if (folder.data.trashed) return markSourceMissing(MESSAGES.TRASHED);
  } catch (err) {
    if (isLostFolderError(err)) {
      return markSourceMissing(lostFolderMessage(err));
    }

    // Transient / unknown Drive errors are retried on the next webhook or
    // poll. Do not persist them as health, and do not walk a folder whose
    // metadata we failed to load.
    publish("Sync failed", err.message);
    console.error("Google Drive folder lookup failed", err);
    return false;
  }

  // A resync clears the folder's id-to-path mappings. Do it only once the
  // folder lookup has succeeded, so a failed lookup does not leave them
  // empty (which would make later writes duplicate remote files).
  if (options.reset) {
    await database
      .folder(folderId, blogID)
      .reset({ preserveVerifiedContent: true });
  }

  // Every file under a local directory, as blog paths. update() on the
  // directory only drops an entry at that exact path, so each file inside
  // must be updated too once the directory is gone.
  const localFiles = async (path) => {
    const files = [];
    const contents = await fs.readdir(localPath(blogID, path), {
      withFileTypes: true,
    });
    for (const item of contents) {
      const child = join(path, item.name);
      if (item.isDirectory()) files.push(...(await localFiles(child)));
      else files.push(child);
    }
    return files;
  };

  const removeLocal = async (path, isLocalDirectory) => {
    const files = isLocalDirectory ? await localFiles(path) : [];
    await fs.remove(localPath(blogID, path));
    for (const file of files) await update(file);
    await update(path);
  };

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
    // google docs to .gdoc files here. Shortcuts are skipped: Blot can't
    // follow them, and one sharing a name with a real item (e.g. a folder
    // next to a shortcut to it) would otherwise take that item's name.
    const remoteContents = transformDriveItems(
      driveItems.filter((item) => item.mimeType !== SHORTCUT)
    )
      .sort((a, b) => comparePaths(a.name, b.name));
    const regularFiles = remoteContents.filter(item =>
      !item.isDirectory && !item.mimeType.startsWith("application/vnd.google-apps.") &&
      item.md5Checksum);
    const verifiedRecords = await getVerifiedContents(regularFiles.map(item => item.id));
    const verifiedById = new Map(regularFiles.map((item, i) => [item.id, verifiedRecords[i]]));

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
        summary.removed += 1;
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
        await removeLocal(path, isLocalDirectory);
        summary.removed += 1;
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
        // e.g. a Drive folder replaced by a Sheet of the same name.
        // download() can't write a file (or placeholder) over a directory,
        // and the folder's child mappings must not outlive it.
        if (existsLocally && existsLocally.isDirectory) {
          await checkWeCanContinue();
          console.log("Removing directory", path, "which is a file remotely");
          await removeLocal(path, true);
          summary.removed += 1;
          const staleId = await getByPath(path);
          if (staleId && staleId !== id) await remove(staleId);
        }

        // Compare against the Drive modifiedTime of the version we last
        // wrote locally, not the local file's mtime: storage backends other
        // than local disk won't offer a settable mtime. The record is only
        // trusted while the local file is unchanged since that write. Files
        // synced before this change have no record yet; their local mtime
        // was set from Drive after each successful download, so fall back
        // to it until they converge below.
        const applied = await getApplied(id);

        // Ensure the file is stored in the database (id <-> path mapping);
        // any folders will be stored as they are walked.
        await set(id, path, { isDirectory, modifiedTime });

        // These do not have a md5Checksum so we fall
        // back to using the modifiedTime
        const isGoogleAppFile = mimeType.startsWith(
          "application/vnd.google-apps."
        );

        const isModifiedTimeCurrent = applied
          ? truncateToSecond(applied.modifiedTime) === truncateToSecond(modifiedTime) &&
            Boolean(applied.fingerprint) && applied.fingerprint === existsLocally?.fingerprint
          : truncateToSecond(existsLocally?.modifiedTime) === truncateToSecond(modifiedTime);

        const cached = verifiedById.get(id);
        const verified = cached && cached.path === path &&
          cached.checksum === md5Checksum && cached.fingerprint &&
          cached.fingerprint === existsLocally?.fingerprint;
        const identical = isGoogleAppFile
          ? isModifiedTimeCurrent
          : md5Checksum
            ? Boolean(verified)
            : existsLocally?.size === size && isModifiedTimeCurrent;

        // Warm old equal-size files incrementally, without turning the first
        // sync after deployment into a complete content scan. A persistent
        // cursor advances on attempts, including failures, for fair retries.
        const legacy = !isGoogleAppFile && md5Checksum && !cached &&
          existsLocally && !existsLocally.isDirectory && existsLocally.size === size;
        if (legacy) {
          if (comparePaths(path, migrationCursor) <= 0 || migrationExhausted || !canMigrate(size)) {
            if (comparePaths(path, migrationCursor) > 0) migrationExhausted = true;
            deferred++;
            progress.publishThrottled("Verification deferred", path);
            continue;
          }
          lastMigrated = path;
        }

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

          if (existsLocally && !existsLocally.isDirectory) {
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

            // A previous rebuild/cache-store may have failed after publication.
            // Rebuild before recording verification, even if bytes now match.
            // Only count downloads that changed local bytes: a verified
            // match (e.g. the legacy verification warm-up) isn't a missed
            // change, even though it still triggers a rebuild below.
            if (result?.updated) {
              summary.downloaded += 1;
              if (modifiedSince(modifiedTime, startedAt)) {
                summary.modifiedDuringWalk += 1;
              }
            }
            if (result?.updated || (!isGoogleAppFile && result?.verifiedContent)) {
              await update(path);
            }
            if (!isGoogleAppFile && result?.verifiedContent) {
              await setVerifiedContent(id, { path, ...result.verifiedContent });
            }

            // Only trust the remote modifiedTime once download() has
            // returned without throwing: pathOnBlot now reflects that remote
            // state. A failed download must not be treated as up to date, so
            // this must not run in the catch below.
            await setApplied(id, {
              modifiedTime,
              fingerprint: await localFingerprint(localPath(blogID, path)),
            });
          } catch (err) {
            publish("Download failed", path);
            console.error("Download failed for", path, err);
          }
        } else {
          progress.publishThrottled("Checking", path);
          // Converge: the local file already matches remotely, even though
          // we only know that via the local-mtime fallback. Store the
          // remote modifiedTime now so future syncs no longer need it.
          if (!applied) {
            await setApplied(id, { modifiedTime, fingerprint: existsLocally?.fingerprint });
          }
        }
      } else {
        if (existsLocally && !existsLocally.isDirectory) {
          await checkWeCanContinue();
          progress.publish("Removing file", path);
          console.log("Removing file", path, "which is a directory remotely");
          await fs.remove(localPath(blogID, path));
          summary.removed += 1;
          publish("Creating directory", path);
          await fs.ensureDir(localPath(blogID, path));
          summary.createdDirs += 1;
          await update(path);
        } else if (!existsLocally) {
          await checkWeCanContinue();
          publish("Creating directory", path);
          console.log("Creating directory locally", path);
          await fs.ensureDir(localPath(blogID, path));
          summary.createdDirs += 1;
          await update(path);
        }

        await walk(path, id);
      }
    }
  };

  try {
    await walk("/", folderId);
    await setMigrationCursor(migrationExhausted ? lastMigrated : "");
    progress.finish(deferred
      ? `Finished processing folder (${deferred} content verifications deferred)`
      : "Finished processing folder");
    return summary;
  } catch (err) {
    if (lastMigrated !== migrationCursor) await setMigrationCursor(lastMigrated);
    publish("Sync failed", err.message);
    return false;
  }
};
