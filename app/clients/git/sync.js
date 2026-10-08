var async = require("async");
var Sync = require("sync");
var debug = require("debug")("blot:clients:git:sync");
var Git = require("simple-git");
var checkGitRepoExists = require("./checkGitRepoExists");
var dataDir = require("./dataDir");
var Blog = require("models/blog");
var validateTree = require("./validateTree");
var fs = require("fs-extra");
var isRedisUnavailableError = require("helper/redisUnavailable").isRedisUnavailableError;

// The working tree is reset to the new commit before the changed paths are
// passed to Blot, and the next sync only compares the commit it starts at
// with the one it ends at. So if Redis cannot take the writes for some paths,
// nothing would ever tell Blot about them. We remember them here, inside the
// blog's .git directory (never part of the working tree), and apply them
// along with whatever the next sync finds. Applying a path twice is harmless.
function unappliedFile(folderPath) {
  return folderPath + "/.git/blot-unapplied-paths.json";
}

function readUnapplied(folderPath, callback) {
  fs.readJson(unappliedFile(folderPath), function (err, paths) {
    // Missing (the usual case) or unreadable: nothing is waiting
    callback(!err && Array.isArray(paths) ? paths : []);
  });
}

function writeUnapplied(folderPath, paths, callback) {
  if (!paths.length) return fs.remove(unappliedFile(folderPath), callback);
  fs.outputJson(unappliedFile(folderPath), paths, callback);
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
        git = Git(folder.path).silent(true);
      } catch (err) {
        return done(err, callback);
      }

      folder.log("Fetching current git commit hash");
      git.raw(["rev-parse", "HEAD"], function (err, headBeforePull) {
        if (err) {
          debug(err);
          return done(new Error(err), callback);
        }

        if (!headBeforePull)
          return done(new Error("No commit on repository"), callback);

        // Remove whitespace from stdout
        headBeforePull = headBeforePull.trim();

        // Update the remote to ensure it's in sync
        var bareRepoDirectory = dataDir + "/" + gitHandle + ".git";
        git.remote(["set-url", "origin", bareRepoDirectory], function (err) {

          if (err) {
            folder.log("Error adding remote: " + err.message);
            debug(err);
            return done(new Error(err), callback);
          }

          // My goal is to update the working tree in the blog folder
          // to the remote's version of the repo. There should never be
          // unpushed or uncommitted changes here, hence the reset. I
          // took these two commands (fetch and then reset) from this answer:
          // https://stackoverflow.com/a/8888015
          folder.log("Syncing blog folder with git repo");
          git.fetch({ "--all": true }, function (err) {
            if (err) {
              folder.log("Error fetching git repo: " + err.message);
              debug(err);
              return done(new Error(err), callback);
            }

            validateTree(git, "origin/master").then(function (commit) {
              git.raw(["reset", "--hard", commit], function (err) {
                if (err) {
                  folder.log("Error resetting git repo: " + err.message);
                  debug(err);
                  return done(new Error(err), callback);
                }

                git.raw(["rev-parse", "HEAD"], function (err, headAfterPull) {
                  if (err) {
                    folder.log("Error getting git commit hash: " + err.message);
                    return done(new Error(err), callback);
                  }

                  if (!headAfterPull) {
                    folder.log("No commits on repository");
                    return done(new Error("No commits on repository"), callback);
                  }

                  // Remove whitespace from stdout
                  headAfterPull = headAfterPull.trim();

                  changedPaths(
                    git,
                    folder,
                    headBeforePull,
                    headAfterPull,
                    function (err, changed) {
                      if (err) return done(err, callback);

                      readUnapplied(folder.path, function (unapplied) {
                        // Left over from a sync that Redis interrupted
                        var modified = unapplied.concat(
                          changed.filter(function (path) {
                            return unapplied.indexOf(path) === -1;
                          })
                        );

                        // Nothing changed, and nothing is waiting
                        if (!modified.length) return done(null, callback);

                        if (unapplied.length) {
                          folder.log(
                            `Found ${unapplied.length} changes left over from an earlier sync`
                          );
                        }

                        modified.forEach(function (path) {
                          folder.log("/" + path, "changed");
                        });

                        // Tell Blot something has changed at these paths!
                        // We must do this in series until entry.set becomes
                        // atomic. Right now, making changes to the blog's
                        // menu cannot be done concurrently, hence eachSeries!
                        var applied = 0;

                        async.eachSeries(
                          modified,
                          function (path, next) {
                            folder.update(path, function (err) {
                              // Redis cannot take the write, so this path
                              // and those after it are not in the database.
                              // Stop and remember them, see above.
                              if (err && isRedisUnavailableError(err))
                                return next(err);

                              // We don't want any other error to stop
                              // processing other files in the sync
                              if (err) console.log("Git client:", err);
                              applied++;
                              next();
                            });
                          },
                          function (err) {
                            if (err) {
                              folder.log(
                                `Redis unavailable, kept ${modified.length - applied} changes for the next sync`
                              );
                              return writeUnapplied(
                                folder.path,
                                modified.slice(applied),
                                function (writeErr) {
                                  if (writeErr) {
                                    folder.log(
                                      "Error saving changes for the next sync: " +
                                        writeErr.message
                                    );
                                  }
                                  done(err, callback);
                                }
                              );
                            }

                            folder.log(`Processed ${modified.length} changes`);
                            writeUnapplied(folder.path, [], function () {
                              done(null, callback);
                            });
                          }
                        );
                      });
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
      if (err) return callback(new Error(err));

      // If you push an empty commit then res
      // will be null, or perhaps a commit and
      // then a subsequent commit which reverts
      // the previous commit.
      if (res === null) return callback(null, []);

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
