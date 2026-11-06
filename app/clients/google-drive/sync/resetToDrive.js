const folder = require("storage/folder");
const { join } = require("path");
const clfdate = require("helper/clfdate");
const database = require("../database");
const localState = require("../util/localState");
const createDriveClient = require("../serviceAccount/createDriveClient");
const CheckWeCanContinue = require("../util/checkWeCanContinue");
const driveReaddir = require("./util/driveReaddir");
const localReaddir = require("./util/localReaddir");
const shouldIgnoreFile = require("clients/util/shouldIgnoreFile");

const truncateToSecond = require("./util/truncateToSecond");

// A remote id with a trustworthy stored modifiedTime is compared against
// that; an id we've never recorded (or don't yet know about) falls back to
// comparing the local file's mtime, matching the previous behaviour.
// Trust the applied record only while the local file is unchanged since
// Blot wrote it (util/localState.js); otherwise fall back to the local mtime.
// entry is the file's listing from localReaddir.
const isRemoteModifiedTimeCurrent = async (
  blogID,
  path,
  priorModifiedTimeById,
  id,
  remoteModifiedTime,
  entry
) => {
  const applied = priorModifiedTimeById.get(id);
  return applied && (await localState.unchanged(blogID, path, applied, entry))
    ? truncateToSecond(applied.modifiedTime) === truncateToSecond(remoteModifiedTime)
    : truncateToSecond(entry.modifiedTime) === truncateToSecond(remoteModifiedTime);
};

module.exports = async (blogID, publish, options = {}) => {
  if (!publish)
    publish = (...args) => {
      console.log(clfdate() + " Google Drive:", args.join(" "));
    };

  const account = await database.blog.get(blogID);
  const { folderId, serviceAccountId } = account;
  const drive = await createDriveClient(serviceAccountId);
  const checkWeCanContinue = CheckWeCanContinue(blogID, account);
  const { reset, set, getAllApplied } = database.folder(folderId, blogID);

  // .gdoc files have no md5Checksum, so we fall back to comparing
  // modifiedTime. Snapshot the applied modifiedTimes before reset() below
  // wipes them; ids without one fall back to the local mtime.
  const priorModifiedTimeById = await getAllApplied();

  const progress = options.publishSyncProgress
    ? {
        current: 0,
        total: await countTransferItems(
          drive,
          blogID,
          "/",
          folderId,
          priorModifiedTimeById
        ),
      }
    : null;

  // reset db.folder state
  await reset();

  let skippedEmpty = 0;

  const walk = async (dir, dirId) => {
    if (!progress) publish("Checking", dir);

    const [remoteContents, localContents] = await Promise.all([
      driveReaddir(drive, dirId),
      localReaddir(blogID, dir),
    ]);

    // Since we reset the database of file ids
    // we need to restore this now
    await set(dirId, dir, { isDirectory: true });

    for (const { name, id } of remoteContents) {
      if (!localContents.find((item) => item.name === name)) {
        await checkWeCanContinue();
        publish("Removing", join(dir, name));
        await drive.files.delete({ fileId: id, supportsAllDrives: true });
      }
    }

    for (const entry of localContents) {
      const { name, isDirectory, modifiedTime, size } = entry;
      const path = join(dir, name);

      if (shouldIgnoreFile(path)) continue;

      const existsOnRemote = remoteContents.find((f) => f.name === name);

      if (isDirectory) {
        let pathId;

        if (
          existsOnRemote &&
          existsOnRemote.mimeType !== "application/vnd.google-apps.folder"
        ) {
          await checkWeCanContinue();
          publish("Removing", path);
          await drive.files.delete({
            fileId: existsOnRemote.id,
            supportsAllDrives: true,
          });
          publishTransferStatus(progress, publish, "Creating directory", path);
          pathId = await mkdir(drive, dirId, name);
        } else if (existsOnRemote && existsOnRemote.id) {
          pathId = existsOnRemote.id;
        } else {
          await checkWeCanContinue();
          publishTransferStatus(progress, publish, "Creating directory", path);
          pathId = await mkdir(drive, dirId, name);
        }

        await walk(path, pathId);
      } else {
        // Blot writes an empty file where it could not download a file
        // (oversized files, Google App files), so a placeholder is
        // indistinguishable from a file that really is empty. Uploading it
        // would put an empty file in Drive, or overwrite the real file
        // already there, so we never upload empty files. The cost is that
        // genuinely empty files do not carry over to Drive.
        if (size === 0) {
          console.log(
            clfdate() + " Google Drive: Skipping empty file (possible placeholder)",
            blogID,
            path
          );
          skippedEmpty += 1;
          publishTransferStatus(progress, publish, "Skipping empty file", path);
          continue;
        }

        // These do not have a md5Checksum so we fall
        // back to using the modifiedTime
        const isGoogleAppFile = name.endsWith(".gdoc");

        const identicalOnRemote =
          existsOnRemote &&
          (isGoogleAppFile
            ? await isRemoteModifiedTimeCurrent(
                blogID,
                path,
                priorModifiedTimeById,
                existsOnRemote.id,
                existsOnRemote.modifiedTime,
                entry
              )
            : existsOnRemote.size === size);

        if (existsOnRemote && !identicalOnRemote) {
          await checkWeCanContinue();
          publishTransferStatus(progress, publish, "Updating", path);
          await set(existsOnRemote.id, path, {
            modifiedTime,
            isDirectory: false,
          });
          await drive.files.update({
            fileId: existsOnRemote.id,
            supportsAllDrives: true,
            media: {
              body: folder.createReadStream(blogID, path),
            },
          });
        } else if (!existsOnRemote) {
          await checkWeCanContinue();
          publishTransferStatus(progress, publish, "Transferring", path);
          const { data } = await drive.files.create({
            resource: {
              name,
              parents: [dirId],
            },
            supportsAllDrives: true,
            media: {
              body: folder.createReadStream(blogID, path),
            },
            fields: "id",
          });
          await set(data.id, path, { modifiedTime, isDirectory: false });
        }
      }
    }
  };

  await walk("/", folderId);

  if (skippedEmpty > 0) {
    publish(
      "Skipped " +
        skippedEmpty +
        " empty file" +
        (skippedEmpty === 1 ? "" : "s") +
        " (possible placeholders for files Blot could not download)"
    );
  }
};

const mkdir = async (drive, parentId, name) => {
  const res = await drive.files.create({
    resource: {
      name,
      parents: [parentId],
      mimeType: "application/vnd.google-apps.folder",
    },
    supportsAllDrives: true,
    fields: "id, name",
  });

  return res.data.id;
};

const countTransferItems = async (drive, blogID, dir, dirId, priorModifiedTimeById) => {
  let count = 0;

  const [remoteContents, localContents] = await Promise.all([
    driveReaddir(drive, dirId),
    localReaddir(blogID, dir),
  ]);

  for (const entry of localContents) {
    const { name, isDirectory, size } = entry;
    const path = join(dir, name);

    if (shouldIgnoreFile(path)) continue;

    const existsOnRemote = remoteContents.find((f) => f.name === name);

    if (isDirectory) {
      if (
        existsOnRemote &&
        existsOnRemote.mimeType === "application/vnd.google-apps.folder" &&
        existsOnRemote.id
      ) {
        count += await countTransferItems(
          drive,
          blogID,
          path,
          existsOnRemote.id,
          priorModifiedTimeById
        );
      } else {
        count += 1;
        count += await countLocalItems(blogID, path);
      }

      continue;
    }

    const isGoogleAppFile = name.endsWith(".gdoc");
    const identicalOnRemote =
      existsOnRemote &&
      (isGoogleAppFile
        ? await isRemoteModifiedTimeCurrent(
            blogID,
            path,
            priorModifiedTimeById,
            existsOnRemote.id,
            existsOnRemote.modifiedTime,
            entry
          )
        : existsOnRemote.size === size);

    if (!existsOnRemote || !identicalOnRemote) count += 1;
  }

  return count;
};

const countLocalItems = async (blogID, dir) => {
  let count = 0;
  const localContents = await localReaddir(blogID, dir);

  for (const { name, isDirectory } of localContents) {
    const path = join(dir, name);

    if (shouldIgnoreFile(path)) continue;

    count += 1;

    if (isDirectory) {
      count += await countLocalItems(blogID, path);
    }
  }

  return count;
};

const publishTransferStatus = (progress, publish, message, path) => {
  if (!progress) {
    publish(message, path);
    return;
  }

  progress.current += 1;
  publish(`(${progress.current}/${progress.total}) Transferring ${path}`);
};
