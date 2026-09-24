var fs = require("fs-extra");
var localPath = require("helper/localPath");
var Git = require("simple-git");
var debug = require("debug")("blot:clients:git:remove");
var checkGitRepoExists = require("./checkGitRepoExists");
var database = require("./database");
var { issueFromSyncError } = require("./error");

// This should probably copy the file to a
// temporary location so the removal can be
// rolled back if we encounter an error
module.exports = function remove (blogID, path, callback) {
  var git;
  var blogDirectory = localPath(blogID, "/");

  debug("Blog:", blogID, "Removing", path);

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

    fs.remove(localPath(blogID, path), function (err) {
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
        // If this path was not tracked by git, no worries.
        // simple-git returns errors as strings, with a trailing
        // newline so we trim this and check against this template
        // This doesn't feel *robust* but it seems to work.
        if (
          err &&
          err.message.trim() ===
            "fatal: pathspec '" + path + "' did not match any files"
        ) {
          return callback(null);
        }

        // simple-git returns errors as strings
        if (err) return callback(new Error(err));

        git.commit("Removed " + path, function (err) {
          if (err) return callback(new Error(err));

          // We push changes made to the bare repository
          git.push(function (err) {
            if (err) return callback(new Error(err));

            debug("Blog:", blogID, "Successfully removed", path);
            database.clearIssue(blogID, function () {
              callback(null);
            });
          });
        });
      });
    });
  });
};
