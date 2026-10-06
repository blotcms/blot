var debug = require("debug")("blot:clients:dropbox:remove");
var createClient = require("./util/createClient");
var join = require("path").join;
var fs = require("fs-extra");
var localPath = require("helper/localPath");
var retry = require("./util/retry");
var persistError = require("./util/persistError");
var { SOURCES } = require("./util/classifyError");
var waitForErrorTimeout = require("./util/waitForErrorTimeout");

// Remove should only ever be called inside the function returned
// from Sync for a given blog, since it modifies the blog folder.
// This method is mildly complicated by the desire to ensure that
// if we fail to remove the file from Dropbox, then we do not
// remove the file from Blot's folder for this blog.
function remove(blogID, path, callback) {
  var pathOnDropbox, pathOnBlot;

  debug("Blog:", blogID, "Removing", path);

  createClient(blogID, function (err, client, account) {
    if (err) {
      return persistError(blogID, err, SOURCES.AUTH, function () {
        callback(err);
      });
    }

    pathOnDropbox = join(account.folder || "/", path);

    pathOnBlot = localPath(blogID, path);

    client
      .filesDelete({
        path: pathOnDropbox,
      })

      // Respect any delay Dropbox would like before
      // potentially retry and requests
      .catch(waitForErrorTimeout)

      .catch(function (err) {
        // This means that error is something other
        // than the file not existing. HTTP 409 means
        // 'CONFLICT' but typically this means that
        // the file did not exist. Am I sure about this?
        if (err.status !== 409) throw err;

        // The file did not exist, no big deal
        return Promise.resolve();
      })
      .then(function () {
        return fs.remove(pathOnBlot);
      })
      .then(function () {
        callback(null);
      })
      .catch(function (err) {
        persistError(blogID, err, SOURCES.APPLY, function () {
          callback(err);
        });
      });
  });
}

module.exports = retry(remove);
