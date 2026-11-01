var async = require("async");
var Sync = require("sync");
var debug = require("debug")("blot:clients:git:sync");
var Git = require("./git");
var checkGitRepoExists = require("./checkGitRepoExists");
var repo = require("./repo");
var Blog = require("models/blog");
var validateTree = require("./validateTree");
var database = require("clients/git/database");
var isRedisUnavailableError = require("helper/redisUnavailable").isRedisUnavailableError;

// The working tree is reset to the new commit before the changed paths are
// passed to Blot, so HEAD says nothing about which commit Blot has applied.
// That is recorded in Redis (database.setApplied) once every path has been
// processed, and each sync diffs from it. Applying a path twice is harmless.

// Calls back with the commit Blot last applied (null if it has not recorded
// one) and the commit to diff from. Normally they are the same. Without a
// recorded commit, or when it is no longer in the clone (a force push and a
// gc), we diff from where the clone was before this sync's fetch, as every
// sync did before the commit was recorded.
//
// A failure to read it is an error: carrying on as if there were none could
// skip the changes the last sync did not get to apply.
function appliedBase(git, folder, blogID, headBeforePull, callback) {
  database.getApplied(blogID, function (err, applied) {
    if (err) {
      folder.log("Error reading applied commit: " + err.message);
      return callback(err);
    }

    if (!applied) return callback(null, null, headBeforePull);

    // Exits non-zero with no output if the commit does not exist
    git.raw(
      ["rev-parse", "--verify", "--quiet", applied + "^{commit}"],
      function (err, found) {
        if (!err && found && found.trim() === applied)
          return callback(null, applied, applied);

        folder.log(
          `Applied commit ${applied} is not in the repo, comparing from ${headBeforePull}`
        );
        callback(null, applied, headBeforePull);
      }
    );
  });
}

module.exports = function sync (blogID, gitHandle, callback) {

  // if the blog ID is not a string, return the callback with an error
  if (typeof blogID !== "string") return callback(new Error("Blog ID must be a string"));

  // if the git handle is not a non-empty string, return the callback with an error
  if (typeof gitHandle !== "string" || !gitHandle) return callback(new Error("Git handle must be a non-empty string"));

  // Attempt to acquire a lock on the blog's folder
  // to apply updates to it... 
  Sync(blogID, function (err, folder, done) {
    // Typically, this error means were unable to acquire a lock
    // on the folder, perhaps another process is syncing it...
    if (err) return callback(err);

    debug("beginning sync");
    folder.log("Checking git repo exists: " + folder.path);
    checkGitRepoExists(folder.path, function (err) {
      if (err) {
        folder.log("Git repo does not exist");
        return done(err, callback);
      } else {
        folder.log("Git repo exists");
      }

      var git;

      // Throws an error if directory does not exist
      try {
        git = Git(folder.path);
      } catch (err) {
        return done(err, callback);
      }

      folder.log("Fetching current git commit hash");
      git.raw(["rev-parse", "HEAD"], function (err, headBeforePull) {
        if (err) {
          debug(err);
          return done(err, callback);
        }

        if (!headBeforePull)
          return done(new Error("No commit on repository"), callback);

        // Remove whitespace from stdout
        headBeforePull = headBeforePull.trim();

        // Update the remote to ensure it's in sync. During a handle change the
        // new handle is saved before its bare repository is renamed, so a
        // follow-up sync can see a handle with no repository yet: origin is
        // then left at the old path (see repo.js).
        repo.pointOriginAtBareRepo(git, gitHandle, function (err) {

          if (err) {
            folder.log("Error adding remote: " + err.message);
            debug(err);
            return done(err, callback);
          }

          // My goal is to update the working tree in the blog folder
          // to the remote's version of the repo. There should never be
          // unpushed or uncommitted changes here, hence the reset. I
          // took these two commands (fetch and then reset) from this answer:
          // https://stackoverflow.com/a/8888015
          folder.log("Syncing blog folder with git repo");
          git.raw(["fetch", "--all"], function (err) {
            if (err) {
              folder.log("Error fetching git repo: " + err.message);
              debug(err);
              return done(err, callback);
            }

            validateTree(git, "origin/master").then(function (commit) {
              git.raw(["reset", "--hard", commit], function (err) {
                if (err) {
                  folder.log("Error resetting git repo: " + err.message);
                  debug(err);
                  return done(err, callback);
                }

                git.raw(["rev-parse", "HEAD"], function (err, headAfterPull) {
                  if (err) {
                    folder.log("Error getting git commit hash: " + err.message);
                    return done(err, callback);
                  }

                  if (!headAfterPull) {
                    folder.log("No commits on repository");
                    return done(new Error("No commits on repository"), callback);
                  }

                  // Remove whitespace from stdout
                  headAfterPull = headAfterPull.trim();

                  appliedBase(
                    git,
                    folder,
                    blogID,
                    headBeforePull,
                    function (err, applied, base) {
                      if (err) return done(err, callback);

                      // Already applied, nothing to do or write
                      if (applied === headAfterPull) {
                        folder.log("No changes to repo");
                        return done(null, callback);
                      }

                      changedPaths(
                        git,
                        folder,
                        base,
                        headAfterPull,
                        function (err, modified) {
                          if (err) return done(err, callback);

                          modified.forEach(function (path) {
                            folder.log("/" + path, "changed");
                          });

                          // Tell Blot something has changed at these paths!
                          // We must do this in series until entry.set becomes
                          // atomic. Right now, making changes to the blog's
                          // menu cannot be done concurrently, hence eachSeries!
                          function finish(err) {
                            if (err) {
                              folder.log(
                                "Redis unavailable, the next sync will apply these changes again"
                              );
                              return done(err, callback);
                            }

                            folder.log(`Processed ${modified.length} changes`);

                            database.setApplied(
                              blogID,
                              headAfterPull,
                              function (err) {
                                if (err) {
                                  folder.log(
                                    "Error recording applied commit: " +
                                      err.message
                                  );
                                  return done(err, callback);
                                }

                                done(null, callback);
                              }
                            );
                          }

                          if (!modified.length) return finish();

                          async.eachSeries(
                            modified,
                            function (path, next) {
                              folder.update(path, function (err) {
                                // Redis cannot take the write, so this path
                                // and those after it are not in the database.
                                // Stop before recording the commit as applied,
                                // the next sync starts from the old one.
                                if (err && isRedisUnavailableError(err))
                                  return next(err);

                                // We don't want any other error to stop
                                // processing other files in the sync
                                if (err) console.log("Git client:", err);
                                next();
                              });
                            },
                            finish
                          );
                        }
                      );
                    }
                  );
                });
              });
            }, function (err) {
              folder.log("Git tree rejected: " + err.message);
              done(err, callback);
            });
          });
        });
      });
    });
  });
};

// Calls back with the paths that differ between two commits
function changedPaths(git, folder, before, after, callback) {
  if (after === before) {
    folder.log("No changes to repo");
    return callback(null, []);
  }

  folder.log(`Comparing ${before} with ${after}`);

  git.raw(
    [
      "diff",
      "--name-status",
      "--no-renames",
      // The 'z' flag will output paths
      // in UTF-8 format, instead of octal
      // Without this flag, files with foreign
      // characters are not synced to Blot.
      "-z",
      before + ".." + after
    ],
    function (err, res) {
      if (err) return callback(err);

      // If you push an empty commit then res will be
      // empty, or perhaps a commit and then a subsequent
      // commit which reverts the previous commit.
      if (!res) return callback(null, []);

      // The output for diff with -z and the other flags looks like:
      // A^@Hello copy.txt^@A^@Hello.txt^@A^@[アーカイブ]/Hello.txt^@
      // So we split on null bytes (^@) and then filter the A/M/Ds
      // which indicated whether the path was added, modified
      var modified = res.split("\u0000").filter((x, i) => i % 2);

      folder.log(`Found ${modified.length} changes to git repo`);

      callback(null, modified);
    }
  );
}
