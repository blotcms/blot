var fs = require("fs-extra");
var localPath = require("helper/localPath");
var Git = require("simple-git");
var debug = require("debug")("blot:clients:git:write");
var checkGitRepoExists = require("./checkGitRepoExists");
const shouldIgnoreFile = require("clients/util/shouldIgnoreFile");
var database = require("./database");
var { issueFromSyncError } = require("./error");

// Used to write a file to the user's blog folder
// contents can be anything supported by fs-extra.outputFile
// which I believe includes buffers and utf8 strings.
module.exports = function write(blogID, path, contents, callback) {
  var git;

  var blogDirectory = localPath(blogID, "/");

  debug("Blog:", blogID, "Writing", path);

  if (shouldIgnoreFile(path)) {
    return callback(new Error(`Cannot write ignored file: ${path}`));
  }

  // Right now local path returns a path with a trailing slash
  // eventually I would like this function to just accept
  // blogDirectory as a first argument...
  if (blogDirectory.slice(-1) === "/")
    blogDirectory = blogDirectory.slice(0, -1);

  checkGitRepoExists(blogDirectory, function (err) {
    if (err) {
      return database.setIssue(blogID, issueFromSyncError(err), function () {
        callback(err);
      });
    }

    fs.outputFile(localPath(blogID, path), contents, function (err) {
      if (err) return callback(err);

      // Throws an error if directory does not exist
      try {
        git = Git(localPath(blogID, "/")).silent(true);
      } catch (err) {
        return callback(err);
      }

      // Git does not like paths with leading slashes
      if (path[0] === "/") path = path.slice(1);

      // Could we queue these commands for better performance?
      git.add(path, function (err) {
        // simple-git returns errors as strings
        if (err) return callback(new Error(err));

        git.commit("Updated " + path, function (err) {
          if (err) return callback(new Error(err));

          // We push changes made to the bare repository
          git.push(function (err) {
            if (err) return callback(new Error(err));

            debug("Blog:", blogID, "Wrote", path);
            database.clearIssue(blogID, function () {
              callback(null);
            });
          });
        });
      });
    });
  });
};
