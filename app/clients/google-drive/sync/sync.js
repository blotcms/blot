const comparePaths = require("./util/comparePaths");
const folder = require("storage/folder");
const { join, dirname, basename } = require("path");
const database = require("../database");
const { forgetFolder } = require("../forget");
const {
  MESSAGES,
  isLostFolderError,
  lostFolderMessage,
  sourceMissingFields,
} = require("../database/error");
const download = require("../util/download");
const prefetch = require("../util/prefetch");
const localState = require("../util/localState");
const hashes = require("../util/hashes");
const createDriveClient = require("../serviceAccount/createDriveClient");
const CheckWeCanContinue = require("../util/checkWeCanContinue");
const shouldIgnoreFile = require("clients/util/shouldIgnoreFile");
const modifiedSince = require("clients/util/modifiedSince");
const localDescendants = require("clients/util/localDescendants");
const {
  countLocalFiles,
  createProgress,
} = require("clients/util/resyncProgress");

const driveReaddir = require("./util/driveReaddir");
const localReaddir = require("./util/localReaddir");

const createLimiter = require("./util/limiter");
const truncateToSecond = require("./util/truncateToSecond");
const transformDriveItems = require("./util/transformDriveItems");

// How many downloads of a directory run at once, ahead of the build
const DOWNLOAD_CONCURRENCY = 4;

const SHORTCUT = "application/vnd.google-apps.shortcut";
const FOLDER = "application/vnd.google-apps.folder";

// The walk lists Drive directories ahead of itself, this many at once (#2847).
// Listing one directory takes 0.2-0.3s whatever its size, so a walk that
// lists them one after another spends most of its time waiting on Drive: on
// a 3,035-item folder in 31 directories, 8.7-9.3s listing one at a time,
// 2.8s four at once, 1.7s eight, 1.15-1.3s sixteen (measured in production,
// 20 Nov 2026). Putting several directories in one query ('a' in parents or
// 'b' in parents) was no faster. Drive allows far more requests per second
// per service account than this uses.
const LISTING_CONCURRENCY = 16;

// Listings fetched ahead but not walked yet are held in memory. Stop listing
// ahead while they hold this many items, so a huge folder can't fill memory
// faster than the walk applies it.
const MAX_PREFETCHED_ITEMS = 20000;

// A full walk stops early when changed directories are waiting (see
// options.dirty below), so a change made during a long walk or bulk download
// isn't held behind it: at most this many times per sync, so the walk always
// gets to finish.
const MAX_YIELDS = 5;
// How often a full walk asks whether changed directories are waiting
const YIELD_CHECK_MS = 250;
// Thrown to stop a full walk that should make way
const YIELD = new Error("Making way for changed directories");

// A hash no Drive md5Checksum has, to unpair a file whose rebuild failed
const UNPAIRED = "0".repeat(32);

// Lists directories ahead of the walk. take(dirId) gives a directory's
// listing (fetched already, in flight, or fetched now), and queues its
// subdirectories at the front, since the depth-first walk needs them next.
// Listings that finish ahead of the walk queue their own subdirectories at
// the back, so the whole tree is listed while the walk works through it.
//
// A listing can be a few seconds older than when the walk reaches it, as with
// any walk: a change Drive records after the listing is picked up by the sync
// its webhook or poll starts, which waits for this one (followUpSync).
function prefetchListings(list, { ahead = true } = {}) {
  const listings = new Map();
  const started = new Set();
  const queue = [];
  let active = 0;
  let buffered = 0;
  let stopped = false;

  const subdirectories = (items) =>
    items
      .filter((item) => item.mimeType === FOLDER)
      .map((item) => item.id)
      .filter((id) => !started.has(id));

  const fetch = (dirId) => {
    started.add(dirId);
    const entry = { size: 0, counted: false, taken: false };
    entry.promise = list(dirId).then((items) => {
      if (!entry.taken) {
        entry.size = items.length;
        entry.counted = true;
        buffered += items.length;
        queue.push(...subdirectories(items));
      }
      return items;
    });
    // A failed listing rejects when the walk takes it, as listing it in the
    // walk would have; until then it mustn't be unhandled.
    entry.promise.catch(() => {});
    listings.set(dirId, entry);
    return entry;
  };

  const pump = () => {
    // One slot is kept for the walk's own listing, which never waits
    while (
      !stopped &&
      active < LISTING_CONCURRENCY - 1 &&
      queue.length &&
      buffered < MAX_PREFETCHED_ITEMS
    ) {
      const dirId = queue.shift();
      if (started.has(dirId)) continue;
      active += 1;
      fetch(dirId)
        .promise.catch(() => {})
        .then(() => {
          active -= 1;
          pump();
        });
    }
  };

  const take = async (dirId) => {
    const entry = listings.get(dirId) || fetch(dirId);
    listings.delete(dirId);
    entry.taken = true;
    if (entry.counted) buffered -= entry.size;
    const items = await entry.promise;
    if (ahead) {
      queue.unshift(...subdirectories(items));
      pump();
    }
    return items;
  };

  const stop = () => {
    stopped = true;
    queue.length = 0;
    listings.clear();
  };

  return { take, stop };
}

// Resolves to a summary of what changed (truthy) when the walk finishes, or
// false when it fails part way through or the folder lookup fails. In that
// case options.onError, if given, receives the error that caused it.
module.exports = async function sync(blogID, publish, update, options = {}) {
  publish = publish || function () {};
  update = update || function () {};
  const onError = options.onError || function () {};

  // With options.detectOnly the walk changes nothing: no folder, mapping or
  // record writes, no downloads. Wherever it would have changed something it
  // notes the directory instead, and the sync resolves { changed: [dirIds],
  // full } (full when the mapping itself has drifted). sync/index.js runs it
  // outside the folder lock and then applies just those directories under
  // the lock (#2847). Its decisions are the walk's own, below.
  const detecting = Boolean(options.detectOnly);
  // Directory id -> its path, for the log
  const changed = new Map();
  let needsFull = false;

  // Files Drive modified after this moment may just be edits that landed
  // mid-walk, not changes we failed to sync. Callers hold the folder lock,
  // so this is (just after) when it was acquired.
  const startedAt = Date.now();
  const summary = {
    downloaded: 0,
    removed: 0,
    createdDirs: 0,
    modifiedDuringWalk: 0,
    // Files that could not be downloaded. The walk carries on past them, so
    // without this a partial walk looks complete; the hourly sweep reports it
    // as a walk error. firstError is a sample.
    failed: 0,
    firstError: null,
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

  // Setup owns the folder until it has copied the site's files into it and
  // cleared preparing (routes/setup.js). A walk before then would remove
  // every file not copied yet, since Drive doesn't have it.
  if (account.preparing) {
    throw new Error("Google Drive setup is still copying this site's files");
  }

  // options.signal is the folder lock's (sync/index.js): once a disconnect
  // aborts it (sync/seize.js), requests in flight are cut off, the walk
  // stops at its next step, and the folder and the mapping refuse writes
  const { signal } = options;
  const drive = await createDriveClient(serviceAccountId, { signal });
  const {
    get: getPath,
    getPaths,
    getByPath,
    move: moveMapping,
    getApplied,
    setApplied,
    set,
    remove,
    getVerifiedContents,
  } = database.folder(folderId, blogID);

  // Drive's md5Checksum of the files in the blog's folder, by SHA-1
  // (util/hashes.js): a file whose SHA-1 is paired with the md5Checksum
  // Drive lists for it is unchanged, without reading it, at whatever path.
  // Saved when the sync finishes (not while detecting, which writes nothing),
  // keeping only what a whole walk used.
  const known = await hashes.load(blogID);
  let walkedWhole = false;
  const checkWeCanContinue = CheckWeCanContinue(blogID, account, signal);
  const progress = createProgress(await countLocalFiles(blogID, "/"), publish);

  // Downloads run side by side, but each one writes into the blog folder only
  // when no other is: File.setMany() reads and rewrites the directory index,
  // so two writes at once could lose an entry.
  const publishToFolder = createLimiter(1);

  // The account stops naming the folder (sourceMissingFields nulls
  // folderId), so its mapping goes too: nothing would read it again or
  // delete it, and a folder that comes back is set up again from scratch
  const markSourceMissing = async (message) => {
    publish("Error syncing with Google Drive");
    await database.blog.update(blogID, sourceMissingFields(account, message));
    await forgetFolder(blogID, folderId);
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
      await database.blog.update(blogID, { folderName: folder.data.name });
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
    onError(err);
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

  // Directory listings for the pass under way; each pass makes its own
  let listings = null;

  // Directory id -> when a change source first saw it change, and which
  // ({ at, source }, from options.dirty.seen), for the live line (#2847)
  const seenDirs = new Map();

  // Throws YIELD when changed directories are waiting, other than the ones
  // the pass is applying (busy), asking Redis at most every YIELD_CHECK_MS.
  // During a bulk upload changes.list records the same directory again with
  // each batch of new files; making way for it would only start that
  // directory over (and use up MAX_YIELDS), so it doesn't count.
  let canYield = false;
  let lastYieldCheck = 0;
  let busy = new Set();
  const maybeYield = async () => {
    if (!canYield || Date.now() - lastYieldCheck < YIELD_CHECK_MS) return;
    lastYieldCheck = Date.now();
    const waiting = await options.dirty.members();
    if (waiting.some((id) => !busy.has(id))) throw YIELD;
  };

  // Folder renames and moves (#2847). Drive keeps a folder's id when it is
  // renamed or moved, so instead of removing the folder and downloading
  // everything in it again under its new name (27s for 100 files on
  // drivetest, with its posts gone from the site meanwhile), the folder is
  // moved in the blog folder. storage/folder.move keeps each file's records,
  // so the files are unchanged where they land and nothing is downloaded; the
  // mapping and the verified records follow, and every old and new path is
  // updated, so posts move (and Blot's rename detection keeps them the same
  // posts). Resolves false, having changed nothing, whenever it can't be sure:
  // something already at the destination, a destination inside the folder
  // itself, an ignored name, or a parent that isn't there.
  // The local listing of each directory a walk is in the middle of, so a move
  // can take the folder out of the listing it left: otherwise a new folder
  // created at its old name in the same pass would look present already
  const listingsInProgress = new Map();
  const forgetLocal = (path) => {
    const listing = listingsInProgress.get(dirname(path));
    const entry = listing?.find((item) => item.name === basename(path));
    if (entry) entry.name = undefined;
  };

  const moveDirectory = async (from, to, id) => {
    if (!id || from === to || from === "/" || to.startsWith(from + "/"))
      return false;
    if (shouldIgnoreFile(to)) return false;
    const mappedThere = await getByPath(to);
    if (mappedThere && mappedThere !== id) return false;
    if (await folder.exists(blogID, to)) return false;
    if (dirname(to) !== "/" && !(await folder.exists(blogID, dirname(to))))
      return false;

    await checkWeCanContinue();
    const descendants = await localDescendants(blogID, from);
    publish("Moving", from);
    console.log("Moving directory", from, "to", to, "as it moved in Drive");
    await folder.move(blogID, from, to);
    await moveMapping(id, to);
    forgetLocal(from);

    const movedPaths = descendants.map((path) => to + path.slice(from.length));
    try {
      await update(from);
      for (const path of descendants) await update(path);
      await update(to);
      for (const path of movedPaths) await update(path);
    } catch (err) {
      // Paired by their bytes, the moved files would match on the next walk
      // and never be rebuilt at their new paths. Pairing their SHA-1s with a
      // hash no md5Checksum has sends them through download() instead, which
      // finds them unchanged, rebuilds them and pairs them again.
      for (const path of movedPaths) {
        try {
          const { sha1 } = await folder.stat(blogID, path, { sha1: true });
          if (sha1) known.set(sha1, UNPAIRED);
        } catch (e) {}
      }
      throw err;
    }

    summary.moved = (summary.moved || 0) + 1;
    return true;
  };

  // Where Drive has a folder now, as a walk of its new parent would name it,
  // or null if that parent isn't in the blog's folder
  const pathInDrive = async (parentId, id) => {
    const parentPath = parentId === folderId ? "/" : await getPath(parentId);
    if (!parentPath) return null;
    const items = transformDriveItems(
      (await driveReaddir(drive, parentId)).filter(
        (item) => item.mimeType !== SHORTCUT
      )
    );
    const item = items.find((each) => each.id === id && each.isDirectory);
    return item ? join(parentPath, item.name) : null;
  };

  // With recurse false, only the directory itself is brought up to date, and
  // only directories it creates are walked below it
  const walk = async (dir, dirId, recurse = true) => {
    if (!dir || !dirId) {
      throw new Error("Missing required arguments for walk");
    }

    // Ensure the dir is stored against the dirId. Detecting, a directory
    // mapped to another path means the mapping has drifted: only a full walk
    // under the lock can be trusted to put it right.
    if (!detecting) await set(dirId, dir, { isDirectory: true });
    else if ((await getPath(dirId)) !== dir) needsFull = true;

    const [driveItems, localContents] = await Promise.all([
      listings.take(dirId),
      localReaddir(blogID, dir),
    ]);
    listingsInProgress.set(dir, localContents);

    // We handle file name deduplication and the mapping of
    // google docs to .gdoc files here. Shortcuts are skipped: Blot can't
    // follow them, and one sharing a name with a real item (e.g. a folder
    // next to a shortcut to it) would otherwise take that item's name.
    const remoteContents = transformDriveItems(
      driveItems.filter((item) => item.mimeType !== SHORTCUT)
    ).sort((a, b) => comparePaths(a.name, b.name));
    const regularFiles = remoteContents.filter(
      (item) =>
        !item.isDirectory &&
        !item.mimeType.startsWith("application/vnd.google-apps.") &&
        item.md5Checksum
    );
    const verifiedRecords = await getVerifiedContents(
      regularFiles.map((item) => item.id)
    );
    const verifiedById = new Map(
      regularFiles.map((item, i) => [item.id, verifiedRecords[i]])
    );

    // Detecting: where the mapping has each item now, in one request
    const mappedPaths = new Map();
    if (detecting) {
      const ids = remoteContents.map((item) => item.id);
      const paths = await getPaths(ids);
      ids.forEach((id, i) => mappedPaths.set(id, paths[i]));
    }

    for (const local of localContents) {
      const { name, isDirectory: isLocalDirectory } = local;
      if (name === undefined) continue;
      const path = join(dir, name);
      // A directory removed in one remove call still accounts for every
      // file total counted inside it, so current must advance by that many.
      const removedCount = isLocalDirectory
        ? await countLocalFiles(blogID, path)
        : 1;

      if (shouldIgnoreFile(path)) {
        if (detecting) {
          changed.set(dirId, dir);
          continue;
        }
        await checkWeCanContinue();
        progress.publish("Removing ignored", path, false, removedCount);
        await folder.remove(blogID, path);
        summary.removed += 1;
        await update(path);
        const id = await getByPath(path);
        if (id) await remove(id);
        continue;
      }

      if (!remoteContents.find((item) => item.name === name)) {
        if (detecting) {
          changed.set(dirId, dir);
          continue;
        }

        // A folder renamed here (the listing has its id under another name)
        // or, by changes.list's hint, moved to another folder of the blog
        if (isLocalDirectory) {
          const id = await getByPath(path);
          const here = id
            ? remoteContents.find((item) => item.id === id && item.isDirectory)
            : null;
          let to = here ? join(dir, here.name) : null;
          if (!to && id && options.dirty?.moveHint) {
            const parentId = await options.dirty.moveHint(id);
            if (parentId) to = await pathInDrive(parentId, id);
          }
          if (to && (await moveDirectory(path, to, id))) {
            // Renamed here: this listing has it under the new name now
            if (here) local.name = here.name;
            continue;
          }
        }

        await checkWeCanContinue();
        progress.publish("Removing", path, false, removedCount);
        console.log(
          "Removing",
          join(dir, name),
          "which does not exist remotely"
        );
        const descendants = isLocalDirectory
          ? await localDescendants(blogID, path)
          : [];
        await folder.remove(blogID, path);
        summary.removed += 1;
        await update(path);
        for (const descendant of descendants) await update(descendant);
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

    // Work out which files need a download, and start those downloads (a few
    // at a time) while earlier files are still being built. The loop below
    // goes through the entries in order and applies each result, so update()
    // still runs one file at a time.
    const limit = createLimiter(DOWNLOAD_CONCURRENCY);
    let stopped = false;

    // Every download queued for this directory. They never reject: each
    // resolves with a result, an error or a stop.
    const downloads = [];
    const startDownload = (task) => {
      const promise = limit(task);
      downloads.push(promise);
      return promise;
    };

    const plan = async ({
      id,
      name,
      isDirectory,
      size,
      modifiedTime,
      mimeType,
      md5Checksum,
    }) => {
      const path = join(dir, name);
      const existsLocally = localContents.find((item) => item.name === name);

      // Compare against the Drive modifiedTime of the version we last
      // wrote to the blog folder, not the file's own modified time, which
      // storage backends other than local disk won't let us set. The
      // record is only trusted while the file is unchanged since that
      // write (util/localState.js). Files synced before applied records
      // existed have none yet; their local mtime was set from Drive after
      // each successful download, so fall back to it until they converge
      // below.
      const applied = await getApplied(id);

      // Ensure the file is stored in the database (id <-> path mapping);
      // any folders will be stored as they are walked.
      if (!detecting) await set(id, path, { isDirectory, modifiedTime });
      else if (mappedPaths.get(id) !== path) changed.set(dirId, dir);

      // These do not have a md5Checksum so we fall
      // back to using the modifiedTime
      const isGoogleAppFile = mimeType.startsWith(
        "application/vnd.google-apps."
      );

      // The SHA-1 of the file Blot holds here, from the folder's index
      const localSha1 =
        existsLocally && !existsLocally.isDirectory
          ? existsLocally.sha1 || null
          : null;
      let identical;

      if (isGoogleAppFile || !md5Checksum) {
        const isModifiedTimeCurrent = applied
          ? truncateToSecond(applied.modifiedTime) ===
              truncateToSecond(modifiedTime) &&
            (await localState.unchanged(blogID, path, applied, existsLocally))
          : truncateToSecond(existsLocally?.modifiedTime) ===
            truncateToSecond(modifiedTime);

        identical = isGoogleAppFile
          ? isModifiedTimeCurrent
          : existsLocally?.size === size && isModifiedTimeCurrent;

        // An empty local copy of a Google App file is a placeholder, and
        // one written before placeholders were flagged goes through
        // download() once more, which flags it (or exports the Doc, if it
        // now can), so it isn't taken for a file which really is empty
        if (
          identical &&
          isGoogleAppFile &&
          existsLocally &&
          !existsLocally.isDirectory &&
          existsLocally.size === 0 &&
          !(await folder.isPlaceholder(blogID, path))
        ) {
          identical = false;
        }
      } else {
        // The file Blot holds has bytes Blot once verified against this
        // md5Checksum, wherever it was then: no download and no read.
        // Anything else falls back to download(), which compares the file's
        // md5 with Drive's before it downloads anything.
        identical = Boolean(
          localSha1 &&
          known.get(localSha1) === md5Checksum.slice(0, 24).toLowerCase()
        );

        // Records from before util/hashes.js, kept per file ID with the
        // path and SHA-1 they were verified at: taken over the first time
        // they match. Drop this, getVerifiedContents and the verified-content
        // keys once every Drive blog has been walked since.
        const cached = !identical && localSha1 ? verifiedById.get(id) : null;
        if (
          cached &&
          cached.checksum === md5Checksum &&
          cached.sha1 === localSha1
        ) {
          identical = true;
          known.set(localSha1, md5Checksum);
        }
      }

      let started = null;
      const needsUpdate = !existsLocally || !identical;

      if (needsUpdate && detecting) {
        changed.set(dirId, dir);
        // Started now, so the apply under the lock finds it downloaded. Not
        // for a file Blot has at the same size, which download() usually
        // finds identical and leaves as it is.
        if (
          !isGoogleAppFile &&
          options.prefetch &&
          !(existsLocally && existsLocally.size === size)
        )
          prefetch.start(drive, { id, md5Checksum, size });
      } else if (needsUpdate) {
        started = startDownload(async () => {
          // Nothing starts once the walk is over or can't continue
          if (stopped) return { stop: new Error("Sync stopped") };
          try {
            await checkWeCanContinue();
          } catch (err) {
            return { stop: err };
          }

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
            return {
              result: await download(
                blogID,
                drive,
                path,
                { id, md5Checksum, mimeType, modifiedTime },
                { serviceAccountId, folderId, publish: publishToFolder }
              ),
              // For the live line's stage timings
              downloadedAt: Date.now(),
            };
          } catch (error) {
            return { error };
          }
        });
      }

      return {
        localSha1,
        isGoogleAppFile,
        started,
        needsUpdate,
        // The applied record is missing, or is from before records held a
        // SHA-1: an unchanged file still gets its record written
        converge: !applied || (!applied.sha1 && Boolean(localSha1)),
      };
    };

    // Plans run in order, ahead of the loop below. A failed plan fails every
    // later one, and the loop throws it when it reaches that file.
    const plans = new Map();
    let previous = Promise.resolve();
    for (const entry of remoteContents) {
      const local = localContents.find((item) => item.name === entry.name);
      // A directory in the way of a file is removed first, in the loop
      if (entry.isDirectory || (local && local.isDirectory)) continue;
      previous = previous.then(() => plan(entry));
      previous.catch(() => {});
      plans.set(entry.id, previous);
    }

    try {
      for (const entry of remoteContents) {
        await maybeYield();
        const { id, name, isDirectory, modifiedTime } = entry;
        const path = join(dir, name);
        const existsLocally = localContents.find((item) => item.name === name);

        // Detecting, note the directory wherever the code below would change
        // something, and only walk on into directories that exist on both
        // sides: a new one is created and walked whole when it is applied.
        if (detecting) {
          if (!isDirectory) {
            if (existsLocally && existsLocally.isDirectory) {
              changed.set(dirId, dir);
              continue;
            }
            const planned = plans.has(id)
              ? await plans.get(id)
              : await plan(entry);
            if (planned.needsUpdate || planned.converge)
              changed.set(dirId, dir);
          } else if (!existsLocally || !existsLocally.isDirectory) {
            changed.set(dirId, dir);
          } else if (recurse) {
            await walk(path, id, true);
          }
          continue;
        }

        if (!isDirectory) {
          // e.g. a Drive folder replaced by a Sheet of the same name.
          // download() can't write a file (or placeholder) over a directory,
          // and the folder's child mappings must not outlive it.
          if (existsLocally && existsLocally.isDirectory) {
            await checkWeCanContinue();
            console.log("Removing directory", path, "which is a file remotely");
            const descendants = await localDescendants(blogID, path);
            await folder.remove(blogID, path);
            summary.removed += 1;
            await update(path);
            for (const descendant of descendants) await update(descendant);
            const staleId = await getByPath(path);
            if (staleId && staleId !== id) await remove(staleId);
          }

          const { localSha1, isGoogleAppFile, started, converge } = plans.has(
            id
          )
            ? await plans.get(id)
            : await plan(entry);

          if (started) {
            // The download may be done already or still running; either way
            // it is applied here, in order. A stop is thrown, not counted as a
            // failed download, and a download that finished after the sync
            // lost its folder isn't applied.
            const outcome = await started;
            if (outcome.stop) throw outcome.stop;
            await checkWeCanContinue();

            try {
              if (outcome.error) throw outcome.error;
              const result = outcome.result;

              if (result?.skippedReason === "exportSizeLimitExceeded") {
                publish("Skipped oversized Google Doc", path);
              }

              // A previous rebuild/cache-store may have failed after publication.
              // Rebuild before recording verification, even if bytes now match.
              // Only count downloads that changed local bytes: a verified
              // match isn't a missed
              // change, even though it still triggers a rebuild below.
              if (result?.updated) {
                summary.downloaded += 1;
                if (modifiedSince(modifiedTime, startedAt)) {
                  summary.modifiedDuringWalk += 1;
                }
              }
              if (
                result?.updated ||
                (!isGoogleAppFile && result?.verifiedContent)
              ) {
                // Drive's modifiedTime, so the sync can log how long the
                // change took to go live, and when it was first seen and
                // downloaded, so the log shows where that time went
                const sighting = seenDirs.get(dirId);
                await update(path, {
                  modified: modifiedTime,
                  since: "drive-modified",
                  seenAt: sighting?.at,
                  seenBy: sighting?.source,
                  downloadedAt: result?.downloadedAt || outcome.downloadedAt,
                });
              }
              const verified = !isGoogleAppFile && result?.verifiedContent;
              if (verified) known.set(verified.sha1, verified.checksum);

              // Only trust the remote modifiedTime once download() has
              // returned without throwing: the blog folder now reflects that remote
              // state. A failed download must not be treated as up to date, so
              // this must not run in the catch below. A verified download
              // already knows the file's SHA-1; anything else is read afresh.
              await setApplied(id, {
                modifiedTime,
                ...(verified
                  ? { sha1: verified.sha1 }
                  : await localState.stateOf(blogID, path)),
              });
            } catch (err) {
              publish("Download failed", path);
              console.error("Download failed for", path, err);
              summary.failed += 1;
              if (!summary.firstError)
                summary.firstError = path + ": " + err.message;
            }
          } else {
            progress.publishThrottled("Checking", path);

            // Converge: the local file already matches remotely, even though
            // we only know that via the local-mtime fallback (or, for a file
            // with an md5Checksum, its SHA-1 pair). Store the remote
            // modifiedTime now so future syncs no longer need it. An applied
            // record with no SHA-1 (written before records held one) is
            // replaced the same way. Without a SHA-1 from the index the
            // record has none either: reading the file to hash it isn't
            // worth it for a file Blot already holds.
            if (converge) {
              await setApplied(id, {
                modifiedTime,
                ...(localSha1 ? { sha1: localSha1 } : {}),
              });
            }
          }
        } else {
          let moved = false;
          const created = !existsLocally || !existsLocally.isDirectory;
          if (existsLocally && !existsLocally.isDirectory) {
            await checkWeCanContinue();
            progress.publish("Removing file", path);
            console.log("Removing file", path, "which is a directory remotely");
            await folder.remove(blogID, path);
            summary.removed += 1;
            publish("Creating directory", path);
            await folder.mkdir(blogID, path);
            summary.createdDirs += 1;
            await update(path);
          } else if (!existsLocally) {
            // A folder moved here from elsewhere in the blog, which this
            // walk reached before the folder it left: move it, contents and
            // all, rather than create it empty and download everything
            const from = await getPath(id);
            if (
              from &&
              from !== path &&
              (await folder.exists(blogID, from)) &&
              (await moveDirectory(from, path, id))
            ) {
              moved = true;
            } else {
              await checkWeCanContinue();
              publish("Creating directory", path);
              console.log("Creating directory locally", path);
              await folder.mkdir(blogID, path);
              summary.createdDirs += 1;
              await update(path);
            }
          }

          // A folder moved here brought its contents with it
          if (recurse || (created && !moved)) await walk(path, id, true);
        }
      }
    } finally {
      listingsInProgress.delete(dir);
      // Downloads not started yet must not start now
      stopped = true;
      // Downloads already running write into the blog folder. Wait for them
      // before the walk returns or rethrows, so none writes after the folder
      // lock is released. Any error from the walk still propagates.
      await previous.catch(() => {});
      await Promise.all(downloads);
    }
  };

  // Runs fn with a fresh set of listings, stopped when it ends
  const pass = async (fn, listingOptions) => {
    listings = prefetchListings(
      (dirId) => driveReaddir(drive, dirId),
      listingOptions
    );
    try {
      await fn();
    } finally {
      // Nothing more is listed once the pass is over
      listings.stop();
    }
  };

  // Brings just the given directories up to date, parents first, except
  // that directories an earlier pass made way in the middle of (resume) come
  // after the rest. A directory the mapping no longer has was removed with
  // its parent, which is dirty too, so it is skipped. If the pass makes way
  // (YIELD), interrupted holds the directories it hadn't finished.
  let interrupted = [];
  const targeted = async (dirIds, resume = new Set()) => {
    const startedAt = Date.now();
    const paths = new Map();
    for (const id of dirIds) {
      paths.set(id, id === folderId ? "/" : await getPath(id));
    }
    const ordered = dirIds
      .filter((id) => paths.get(id))
      .sort(
        (a, b) =>
          resume.has(a) - resume.has(b) ||
          paths.get(a).split("/").length - paths.get(b).split("/").length
      );
    if (options.dirty?.seen) {
      const seen = await options.dirty.seen(ordered).catch(() => ({}));
      for (const [id, sighting] of Object.entries(seen))
        seenDirs.set(id, sighting);
    }
    const done = new Set();
    busy = new Set(ordered);
    try {
      await pass(
        async () => {
          for (const id of ordered) {
            const path = id === folderId ? "/" : await getPath(id);
            if (path) await walk(path, id, false);
            done.add(id);
          }
        },
        { ahead: false }
      );
    } catch (err) {
      if (err === YIELD) interrupted = ordered.filter((id) => !done.has(id));
      throw err;
    } finally {
      busy = new Set();
    }
    console.log(
      "Google Drive Sync:",
      blogID,
      `targeted dirs=${ordered.length} ms=${Date.now() - startedAt}`,
      // Which directories, so each can be matched with the source that saw
      // it change first (#2847)
      `paths=${JSON.stringify(ordered.map((id) => paths.get(id)).slice(0, 20))}`
    );
  };

  if (detecting) {
    // A detection makes way too, so directories changes.list records while
    // it walks are applied without waiting for it (sync/index.js)
    canYield = Boolean(options.dirty);
    try {
      // With options.only, just those directories, not below them: the
      // directories that changed in the last few minutes, checked beside the
      // full detection so a change in one is found in one listing. The
      // directories are listed side by side (the walk changes nothing
      // here, so they can't get in each other's way)
      if (options.only) {
        await pass(
          () =>
            Promise.all(
              options.only.map(async (id) => {
                const path = id === folderId ? "/" : await getPath(id);
                if (path) await walk(path, id, false);
              })
            ),
          { ahead: false }
        );
      } else {
        await pass(() => walk("/", folderId));
      }
      return {
        changed: [...changed.keys()],
        paths: [...changed.values()],
        full: needsFull,
      };
    } catch (err) {
      if (err === YIELD) return { yielded: true, changed: [], full: false };
      onError(err);
      return false;
    }
  }

  // Directory ids taken from options.dirty, put back if the sync fails
  const taken = [];

  try {
    // options.dirty (from sync/index.js) holds the directories changes.list
    // and the search saw change (#2847). They are listed first, so a change
    // goes live after one listing instead of after the whole walk. The full
    // walk still follows, as before, and logs anything the targeted pass
    // missed. While it runs, directories that change make it stop and start
    // again after them, up to MAX_YIELDS times.
    //
    // A targeted pass makes way too: a large directory (a bulk upload) can
    // take tens of seconds to apply, and a change recorded meanwhile goes
    // first. What it hadn't finished is put back and done after the new
    // directories. MAX_YIELDS counts every pass's yields together.
    let yields = 0;
    let wantFull = false;
    let resume = new Set();
    for (;;) {
      const ids = options.dirty ? await options.dirty.take() : [];
      taken.push(...ids);
      if (ids.includes(options.dirty?.FULL)) wantFull = true;
      const dirIds = ids.filter((id) => id !== options.dirty?.FULL);

      canYield = Boolean(options.dirty) && yields < MAX_YIELDS;
      if (dirIds.length) {
        try {
          await targeted(dirIds, resume);
          resume = new Set();
        } catch (err) {
          if (err !== YIELD) throw err;
          yields += 1;
          resume = new Set(interrupted);
          await options.dirty.putBack(interrupted);
          console.log(
            "Google Drive Sync:",
            blogID,
            `targeted pass yielded n=${yields} left=${interrupted.length}`
          );
          continue;
        }
      }

      // Applying what a detection found (sync/index.js), the full walk runs
      // only when it was asked for. Directories recorded while the targeted
      // pass ran are left to the next apply, which sync/index.js runs
      // straight after: releasing the folder lock between them lets the hot
      // doc poller and other writers in during a long bulk upload, which keeps
      // recording the same directory again.
      if (options.fullWalk === "if-asked" && !wantFull) break;

      const before = { ...summary };
      canYield = Boolean(options.dirty) && yields < MAX_YIELDS;
      try {
        await pass(() => walk("/", folderId));
        walkedWhole = true;
      } catch (err) {
        if (err !== YIELD) throw err;
        yields += 1;
        console.log(
          "Google Drive Sync:",
          blogID,
          `full walk yielded n=${yields}`
        );
        continue;
      }

      if (dirIds.length) {
        const missed = ["downloaded", "removed", "createdDirs"]
          .map((field) => [field, summary[field] - before[field]])
          .filter(([, n]) => n > 0);
        if (missed.length)
          console.log(
            "Google Drive Sync:",
            blogID,
            "full walk after targeted pass changed",
            missed.map(([field, n]) => `${field}=${n}`).join(" "),
            `modifiedDuringWalk=${summary.modifiedDuringWalk - before.modifiedDuringWalk}`
          );
      }
      break;
    }
    progress.finish("Finished processing folder");
    // A whole walk that downloaded everything saw every file, so the pairs
    // it didn't use (files gone, or edited since) are dropped
    await known.save({ complete: walkedWhole && summary.failed === 0 });
    return summary;
  } catch (err) {
    // What the walk verified before it stopped still holds
    await known.save({ complete: false });
    if (options.dirty && taken.length) {
      await options.dirty
        .putBack(taken)
        .catch((e) => console.error("Google Drive Sync: put back failed", e));
    }
    publish("Sync failed", err.message);
    onError(err);
    return false;
  }
};
