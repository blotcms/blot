var async = require("async");
var Sync = require("sync");
var debug = require("debug")("blot:clients:git:sync");
var Git = require("./git");
var checkGitRepoExists = require("./checkGitRepoExists");
var repo = require("./repo");
var Blog = require("models/blog");
var validateTree = require("./validateTree");
var database = require("./database");
var materialize = require("./materialize");
var isRedisUnavailableError = require("helper/redisUnavailable").isRedisUnavailableError;

var EMPTY_TREE = materialize.EMPTY_TREE;

// The blog folder is brought to the new commit by materialize.js, straight from
// the bare repository, before the changed paths are passed to Blot, so the
// folder says nothing about which commit Blot has applied. That is recorded in
// Redis (database.setApplied) once every path has been processed, and each sync
// diffs from it. Applying a path twice is harmless.
//
// The live clone in the blog folder's .git directory is not used to find
// changes any more, but Blot's own writes still commit in it and push to the
// bare repository (see repo.commit), so it is kept at the new commit too, by
// followBareRepo below. Remove that when the live clones go.

// Calls back with true if the repository has the commit
function hasCommit(bare, commit, callback) {
  // Exits non-zero with no output if the commit does not exist
  bare.raw(["rev-parse", "--verify", "--quiet", commit + "^{commit}"], function (err, found) {
    callback(!err && !!found && found.trim() === commit);
  });
}

// Calls back with the commit to diff from, the one Blot last applied. Without
// a recorded commit, or when it is no longer in the repository (a force push
// and a gc), that is where the live clone is now, before this sync moves it,
// which is where the blog folder was. If the repository has lost that too, it
// is the empty tree: every file is written, and files which should be gone are
// not removed until a resync. It is recorded here so a sync that stops part way
// starts from it again, rather than from wherever the live clone is by then.
//
// A failure to read it is an error: carrying on as if there were none could
// skip the changes the last sync did not get to apply.
function appliedBase(bare, folder, blogID, headBeforePull, callback) {
  function startFromClone() {
    hasCommit(bare, headBeforePull, function (found) {
      var base = found ? headBeforePull : EMPTY_TREE;

      if (!found)
        folder.log(`Commit ${headBeforePull} is not in the repo, comparing from nothing`);

      database.setApplied(blogID, base, function (err) {
        if (err) {
          folder.log("Error recording applied commit: " + err.message);
          return callback(err);
        }

        callback(null, base);
      });
    });
  }

  database.getApplied(blogID, function (err, applied) {
    if (err) {
      folder.log("Error reading applied commit: " + err.message);
      return callback(err);
    }

    if (!applied) return startFromClone();

    if (applied === EMPTY_TREE) return callback(null, applied);

    hasCommit(bare, applied, function (found) {
      if (found) return callback(null, applied);

      folder.log(`Applied commit ${applied} is not in the repo, comparing from ${headBeforePull}`);
      startFromClone();
    });
  });
}

// Moves the live clone's HEAD and index to the commit without touching the
// blog folder, which materialize has already brought there (a mixed reset). It
// is what Blot's next commit in the live clone is made on top of, so that it
// can be pushed to the bare repository. Before this the same reset --hard did
// that and wrote the files.
function followBareRepo(git, folder, gitHandle, commit, callback) {
  // During a handle change the new handle is saved before its bare repository
  // is renamed (see repo.js)
  repo.pointOriginAtBareRepo(git, gitHandle, function (err) {
    if (err) {
      folder.log("Error adding remote: " + err.message);
      debug(err);
      return callback(err);
    }

    git.raw(["fetch", "--all"], function (err) {
      if (err) {
        folder.log("Error fetching git repo: " + err.message);
        debug(err);
        return callback(err);
      }

      git.raw(["reset", "--mixed", "--quiet", commit], function (err) {
        if (err) {
          folder.log("Error resetting git repo: " + err.message);
          debug(err);
        }

        callback(err);
      });
    });
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
      var bare;

      // Throws an error if directory does not exist
      try {
        git = Git(folder.path);
        bare = Git(repo.directory(gitHandle));
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

        // Validate the commit once, then use that same ID throughout: the
        // branch may move while we work
        validateTree(bare, "refs/heads/master").then(function (commit) {
          appliedBase(bare, folder, blogID, headBeforePull, function (err, base) {
            if (err) return done(err, callback);

            folder.log("Syncing blog folder with git repo");
            followBareRepo(git, folder, gitHandle, commit, function (err) {
              if (err) return done(err, callback);

              // Already applied, nothing to do or write
              if (base === commit) {
                folder.log("No changes to repo");
                return done(null, callback);
              }

              folder.log(`Comparing ${base} with ${commit}`);

              materialize(repo.directory(gitHandle), folder, base, commit, function (err, modified) {
                if (err) {
                  folder.log("Error updating blog folder: " + err.message);
                  debug(err);
                  return done(err, callback);
                }

                folder.log(`Found ${modified.length} changes to git repo`);

                modified.forEach(function (path) {
                  folder.log("/" + path, "changed");
                });

                function finish(err) {
                  if (err) {
                    folder.log(
                      "Redis unavailable, the next sync will apply these changes again"
                    );
                    return done(err, callback);
                  }

                  folder.log(`Processed ${modified.length} changes`);

                  database.setApplied(blogID, commit, function (err) {
                    if (err) {
                      folder.log(
                        "Error recording applied commit: " + err.message
                      );
                      return done(err, callback);
                    }

                    done(null, callback);
                  });
                }

                if (!modified.length) return finish();

                // Tell Blot something has changed at these paths!
                // We must do this in series until entry.set becomes
                // atomic. Right now, making changes to the blog's
                // menu cannot be done concurrently, hence eachSeries!
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
              });
            });
          });
        }, function (err) {
          folder.log("Git tree rejected: " + err.message);
          done(err, callback);
        });
      });
    });
  });
};
