var debug = require("debug")("blot:clients:dropbox:remove");
var loadClient = require("./util/loadClient");
var join = require("path").join;
var folder = require("storage/folder");
var retry = require("./util/retry");
var persistError = require("./util/persistError");
var { SOURCES } = require("./util/classifyError");
var waitForErrorTimeout = require("./util/waitForErrorTimeout");

// Remove should only ever be called inside the function returned
// from Sync for a given blog, since it modifies the blog folder.
// This method is mildly complicated by the desire to ensure that
// if we fail to remove the file from Dropbox, then we do not
// remove the file from Blot's folder for this blog.
async function remove(blogID, path) {
  var pathOnDropbox;

  debug("Blog:", blogID, "Removing", path);

  const { error, client, account } = await loadClient(blogID);

  if (error) {
    await persistError(blogID, error, SOURCES.AUTH).catch(function () {});
    throw error;
  }

  pathOnDropbox = join(account.folder || "/", path);

  try {
    try {
      await client.filesDelete({
        path: pathOnDropbox,
      });
    } catch (err) {
      // Respect any delay Dropbox would like before
      // potentially retry and requests
      try {
        await waitForErrorTimeout(err);
      } catch (err) {
        // This means that error is something other
        // than the file not existing. HTTP 409 means
        // 'CONFLICT' but typically this means that
        // the file did not exist. Am I sure about this?
        if (err.status !== 409) throw err;

        // The file did not exist, no big deal
      }
    }

    await folder.remove(blogID, path);
  } catch (err) {
    await persistError(blogID, err, SOURCES.APPLY).catch(function () {});
    throw err;
  }
}

module.exports = retry(remove);
