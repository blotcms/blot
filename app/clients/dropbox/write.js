var join = require("path").join;
var debug = require("debug")("blot:clients:dropbox:write");
var loadClient = require("./util/loadClient");
var folder = require("storage/folder");
var guard = require("storage/folder/guard");
var retry = require("./util/retry");
var persistError = require("./util/persistError");
var database = require("./database");
var { SOURCES } = require("./util/classifyError");
const upload = require("clients/dropbox/util/upload");
const shouldIgnoreFile = require("clients/util/shouldIgnoreFile");
const fs = require("fs-extra");
const tempDir = require("helper/tempDir");
const { v4: uuid } = require("uuid");

// Write should only ever be called inside the function returned
// from Sync for a given blog, since it modifies the blog folder.
async function write(blogID, path, contents) {
  var pathInDropbox;

  debug("Blog:", blogID, "Writing", path);

  if (shouldIgnoreFile(path)) {
    throw new Error(`Cannot write ignored file: ${path}`);
  }

  var { error, client, account } = await loadClient(blogID);

  if (error || !account) {
    error = error || new Error("No account");
    await persistError(blogID, error, SOURCES.AUTH).catch(function () {});
    throw error;
  }

  // We assume that the account's folder has not changed
  // to be perfectly correct, we could check this before
  // each write but it would double the requests needed
  pathInDropbox = join(account.folder || "/", path);

  // Dropbox first, then Blot's folder. The other way round, a process killed
  // between the two leaves a file only Blot has, which the next walk of the
  // folder (sync/reset-to-blot.js) deletes since Dropbox lacks it. This way a
  // file only Dropbox has is downloaded by the next sync instead.
  const staged = join(tempDir(), "dropbox-write-" + uuid());

  try {
    await fs.outputFile(staged, contents);
    // A disconnect has stopped the sync this runs in (sync/seize.js): its
    // write to Blot's folder below would be refused, so don't upload either
    guard.check(blogID);
    await upload(client, staged, pathInDropbox);
    await folder.write(blogID, path, contents);
  } catch (e) {
    await persistError(blogID, e, SOURCES.APPLY).catch(function () {});
    throw e;
  } finally {
    await fs.remove(staged).catch(function () {});
  }

  // A successful upload shows access, the folder and storage are all
  // fine, so it is the recovery path for a persisted quota error.
  if (!account.error_code) return;

  await database.set(blogID, { error_code: 0 }).catch(function () {});
}

module.exports = retry(write);
