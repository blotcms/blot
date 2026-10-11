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

const set = promisify(database.set);

function abortIfRequested(signal) {
  if (signal && signal.aborted) {
    const err = new Error("OneDrive reset aborted");
    err.name = "AbortError";
    throw err;
  }
}

// Makes the blog's OneDrive folder match the blog folder on Blot: uploads
// new and changed files, creates directories and deletes anything in
// OneDrive that isn't in the blog. Used when first connecting and to
// repair OneDrive from Blot. Callers should hold the folder lock.
async function resetFromBlot(blogID, publish, signal) {
  if (!publish) {
    publish = function () {
      console.log(clfdate() + " OneDrive:", Array.from(arguments).join(" "));
    };
  }

  const account = await verifyFolder(blogID);
  const localRoot = localPath(blogID, "/");

  publish("Counting files...");
  const progress = createProgress(await countLocalFiles(localRoot), publish);

  const walk = async function (dir) {
    abortIfRequested(signal);

    const [remote, local] = await Promise.all([
      graph.listChildren(blogID, account.folder_id, dir),
      localReaddir(localRoot, dir),
    ]);

    for (const remoteItem of remote) {
      abortIfRequested(signal);

      const path = join(dir, remoteItem.name);
      const stillLocal = local.find((item) => item.name === remoteItem.name);

      // Blot never syncs ignored files (.DS_Store etc), so leave any in
      // OneDrive alone rather than deleting what the user put there.
      if (stillLocal || shouldIgnoreFile(path)) continue;

      publish("Removing", path);
      await graph.deleteItem(blogID, account.folder_id, path);
    }

    for (const item of local) {
      abortIfRequested(signal);

      const path = join(dir, item.name);

      if (shouldIgnoreFile(path)) continue;

      const counterpart = remote.find((r) => r.name === item.name);

      if (item.is_directory) {
        publish("Checking", path);

        if (counterpart && !counterpart.is_directory) {
          await graph.deleteItem(blogID, account.folder_id, path);
        }

        if (!counterpart || !counterpart.is_directory) {
          await graph.mkdir(blogID, account.folder_id, path);
        }

        await walk(path);
        continue;
      }

      progress.publish("Transferring", path);

      if (counterpart && counterpart.is_directory) {
        await graph.deleteItem(blogID, account.folder_id, path);
      } else if (counterpart && counterpart.sha1 === item.sha1) {
        continue;
      }

      try {
        await graph.upload(blogID, account.folder_id, path, join(localRoot, path));
      } catch (err) {
        // Revoked access or full storage will fail every remaining file
        // too, so stop and report it. Anything else (an invalid file name,
        // say) only affects this file.
        if (classify(err, SOURCES.APPLY).persist) throw err;
        publish("Failed to transfer", path, err.message);
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
}

module.exports = resetFromBlot;
