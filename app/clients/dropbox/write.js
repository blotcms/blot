var join = require("path").join;
var debug = require("debug")("blot:clients:dropbox:write");
var createClient = require("./util/createClient");
var fs = require("fs-extra");
var localPath = require("helper/localPath");
var retry = require("./util/retry");
var persistError = require("./util/persistError");
var database = require("./database");
var { SOURCES } = require("./util/classifyError");
const { promisify } = require("util");
const upload = promisify(require("clients/dropbox/util/upload"));
const shouldIgnoreFile = require("clients/util/shouldIgnoreFile");

// Write should only ever be called inside the function returned
// from Sync for a given blog, since it modifies the blog folder.
function write(blogID, path, contents, callback) {
  var pathInDropbox, pathOnBlot;

  debug("Blog:", blogID, "Writing", path);

  if (shouldIgnoreFile(path)) {
    return callback(new Error(`Cannot write ignored file: ${path}`));
  }

  createClient(blogID, async function (err, client, account) {
    if (err || !account) {
      err = err || new Error("No account");
      return persistError(blogID, err, SOURCES.AUTH, function () {
        callback(err);
      });
    }

    // We assume that the account's folder has not changed
    // to be perfectly correct, we could check this before
    // each write but it would double the requests needed
    pathInDropbox = join(account.folder || "/", path);

    pathOnBlot = localPath(blogID, path);

    try {
      await fs.outputFile(pathOnBlot, contents);
      await upload(client, pathOnBlot, pathInDropbox);
    } catch (e) {
      return persistError(blogID, e, SOURCES.APPLY, function () {
        callback(e);
      });
    }

    // A successful upload shows access, the folder and storage are all
    // fine, so it is the recovery path for a persisted quota error.
    if (!account.error_code) return callback();

    database.set(blogID, { error_code: 0 }, function () {
      callback();
    });
  });
}

module.exports = retry(write);
