const fs = require("fs-extra");
const { join } = require("path");
const clfdate = require("helper/clfdate");
const localPath = require("helper/localPath");
const shouldIgnoreFile = require("clients/util/shouldIgnoreFile");
const { countLocalFiles, createProgress } = require("clients/util/resyncProgress");
const { promisify } = require("util");
const graph = require("../util/graph");
const database = require("../database");
const verifyFolder = require("./verifyFolder");
const localReaddir = require("./localFiles");
const { persistError } = require("../util/persistError");
const { classify, SOURCES } = require("../util/classifyError");
const { MAX_FILE_SIZE } = require("../util/constants");

const set = promisify(database.set);

// Makes the blog folder on Blot match the blog's OneDrive folder: the
// reverse of reset-from-blot. Downloads new and changed files, creates
// directories and deletes local files that aren't in OneDrive. This is the
// client's `resync`, called from the dashboard's reset tools with the same
// (blogID, publish, update) contract as the other clients; `update(path)`
// is called as each path changes so the blog follows the folder even if the
// walk fails part way. Callers should hold the folder lock.
async function resetToBlot(blogID, publish, update) {
  if (!publish) {
    publish = function () {
      console.log(clfdate() + " OneDrive:", Array.from(arguments).join(" "));
    };
  }

  const updatePath = async function (path) {
    if (typeof update !== "function") return;

    try {
      await update(path);
    } catch (err) {
      publish("Failed to update", path, err.message);
    }
  };

  publish("Syncing folder from OneDrive to Blot");

  const account = await verifyFolder(blogID);
  const localRoot = localPath(blogID, "/");
  const summary = { downloaded: 0, removed: 0, createdDirs: 0, skipped: 0 };
  const progress = createProgress(await countLocalFiles(localRoot), publish);

  const walk = async function (dir) {
    const [remote, local] = await Promise.all([
      graph.listChildren(blogID, account.folder_id, dir),
      localReaddir(localRoot, dir),
    ]);

    for (const item of local) {
      const path = join(dir, item.name);
      const onDisk = join(localRoot, path);

      if (remote.find((r) => r.name === item.name) && !shouldIgnoreFile(path)) {
        continue;
      }

      // Removing a directory accounts for every file counted inside it
      const count = item.is_directory ? await countLocalFiles(onDisk) : 1;

      progress.publish("Removing", path, false, count);

      try {
        await fs.remove(onDisk);
        summary.removed += 1;
        await updatePath(path);
      } catch (err) {
        publish("Failed to remove", path, err.message);
      }
    }

    progress.discover(
      remote.filter(
        (r) =>
          !r.is_directory &&
          !shouldIgnoreFile(join(dir, r.name)) &&
          !local.find((l) => l.name === r.name)
      ).length
    );

    for (const remoteItem of remote) {
      const path = join(dir, remoteItem.name);
      const onDisk = join(localRoot, path);
      const counterpart = local.find((l) => l.name === remoteItem.name);

      if (shouldIgnoreFile(path)) continue;

      if (remoteItem.is_directory) {
        if (counterpart && !counterpart.is_directory) {
          await fs.remove(onDisk);
          summary.removed += 1;
          await updatePath(path);
        }

        if (!counterpart || !counterpart.is_directory) {
          try {
            await fs.mkdir(onDisk);
            summary.createdDirs += 1;
            await updatePath(path);
          } catch (err) {
            if (err.code !== "ENAMETOOLONG") throw err;
            summary.skipped += 1;
            continue;
          }
        }

        await walk(path);
        continue;
      }

      const additional = !!(counterpart && counterpart.is_directory);

      // Too big to keep on Blot: leave an empty placeholder
      if (typeof remoteItem.size === "number" && remoteItem.size > MAX_FILE_SIZE) {
        progress.publish("Skipping oversized file", path, additional);
        summary.skipped += 1;
        try {
          await fs.outputFile(onDisk, "");
          await updatePath(path);
        } catch (err) {
          publish("Failed to create placeholder", path, err.message);
        }
        continue;
      }

      if (counterpart && !counterpart.is_directory && counterpart.sha1 === remoteItem.sha1) {
        progress.publishThrottled("Checking", path);
        continue;
      }

      progress.publish("Downloading", path, additional);

      try {
        if (additional) await fs.remove(onDisk);
        await graph.download(blogID, remoteItem, onDisk);
        summary.downloaded += 1;
        await updatePath(path);
      } catch (err) {
        if (classify(err, SOURCES.APPLY).persist) throw err;
        if (err.code === "ENAMETOOLONG") summary.skipped += 1;
        publish("Failed to download", path, err.message);
      }
    }
  };

  try {
    await walk("/");
  } catch (err) {
    await persistError(blogID, err, SOURCES.APPLY);
    throw err;
  }

  await set(blogID, { last_sync: Date.now() });

  progress.finish("Finished processing folder");

  return summary;
}

module.exports = resetToBlot;
