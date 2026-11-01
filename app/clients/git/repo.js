// The one place that knows where a blog's bare repository is and how it is
// served, written to and watched, so the rest of the git client asks for what
// it wants (serve this request, a push happened, commit this change) and does
// not build paths or talk to git's protocol.
//
// Repositories are keyed by the blog's handle for now, so the functions that
// are not about one blog take the handle.
var fs = require("fs-extra");
var debug = require("debug")("blot:clients:git:repo");
var localPath = require("helper/localPath");
var lock = require("helper/lock");
var clfdate = require("helper/clfdate");
var Git = require("./git");
var dataDir = require("./dataDir");
var checkGitRepoExists = require("./checkGitRepoExists");
var smartHttp = require("./smartHttp");
var database = require("./database");

// Set with onPush
var pushed = function () {};
var prepare = null;
var abandon = null;

// The short lock on a blog's refs. It is held to move refs, by a push which
// has already been received and checked and by Blot's own commit, and never
// while a push is being received, so it is nothing like the sync's folder
// lock, which Blot's commits happen inside of. It expires by itself after a
// few seconds if the process holding it dies.
function refLockKey(blogID) {
  return "blog:" + blogID + ":git:ref-lock";
}

// Resolves to a function which releases the lock. Waits a few seconds for it,
// then rejects with code ELOCKED.
function holdRefLock(blogID) {
  return lock(refLockKey(blogID), {
    ttl: 10 * 1000,
    heartbeat: 3 * 1000,
    retries: 6,
    minTimeout: 250,
    onCompromised: function (err) {
      console.error(clfdate(), "Git: lost the ref lock of", blogID, err.message);
    },
  }).then(function (held) {
    return held.release;
  });
}

// What a push needs from the rest of Blot, see receivePack.js
function receiveHooks(blogID) {
  return {
    lock: function () {
      return holdRefLock(blogID);
    },
    prepare: function (master) {
      return prepare ? prepare(blogID, master.old, master.new) : undefined;
    },
    abandoned: function (master, prepared) {
      return abandon ? abandon(blogID, prepared) : undefined;
    },
    accepted: function (master, prepared) {
      pushed(blogID, master.old, master.new, prepared);
    },
  };
}

// Where a blog's bare repository lives, given its git handle
function directory(handle) {
  return dataDir + "/" + handle + ".git";
}

function exists(handle, callback) {
  fs.access(directory(handle), function (err) {
    callback(!err);
  });
}

// Serves a smart HTTP request (ref advertisement, fetch, push) for the blog's
// repository. The request has been authenticated as having access to the
// blog, and its URL names the blog's current handle (req.gitHandle).
function handleSmartHttp(req, res, blogID) {
  req.blogID = blogID;

  smartHttp.handle(req, res, directory(req.gitHandle), receiveHooks(blogID));
}

// callback is called with (blogID, old, new, prepared) when a push has moved
// master, as soon as it has and before the client is told, whether or not the
// client is still there to be told. Blot's sync follows.
//
// options.prepare(blogID, old, new) runs just before a push moves master,
// while the refs are locked. It is where the sync is recorded durably, so
// that a push the client is told succeeded can't be lost to a crash; if it
// rejects, the push fails and nothing moves. What it resolves to is passed to
// callback. options.abandon(blogID, prepared) is called if the refs then did
// not move.
function onPush(callback, options) {
  pushed = callback;
  prepare = (options && options.prepare) || null;
  abandon = (options && options.abandon) || null;
}

// The live checkout in the blog folder pushes to and fetches from its
// 'origin' remote, which should be the bare repository. The stored URL can
// go stale (for example if the data directory has moved), so we reset it
// before talking to the remote.
//
// We only do so if the bare repository exists at the new path. When a blog's
// handle changes, the new handle is saved before the bare repository is
// renamed (and the rename can fail), so the handle we look up may not have a
// repository yet. In that case 'origin' is left alone, since it still points
// at the old path, which exists during the rename.
function pointOriginAtBareRepo(git, handle, callback) {
  var bareRepoDirectory = directory(handle);

  fs.stat(bareRepoDirectory, function (err, stat) {
    if (err || !stat.isDirectory()) {
      debug(
        "Bare repository does not exist at",
        bareRepoDirectory,
        "leaving origin unchanged"
      );
      return callback(null);
    }

    git.raw(["remote", "set-url", "origin", bareRepoDirectory], function (err) {
      callback(err || null);
    });
  });
}

// Makes one change to the blog's repository: writes the file, or removes it
// if contents is null, and commits and pushes it. Used by the client's write
// and remove methods.
//
//   commit(blogID, { path: "/a.txt", contents: "A" }, callback)
function commit(blogID, change, callback) {
  var path = change.path;
  var contents = change.contents;
  var git;
  var blogDirectory = localPath(blogID, "/");

  // Right now local path returns a path with a trailing slash
  // eventually I would like this function to just accept
  // blogDirectory as a first argument...
  if (blogDirectory.slice(-1) === "/")
    blogDirectory = blogDirectory.slice(0, -1);

  checkGitRepoExists(blogDirectory, function (err) {
    if (err) return callback(err);

    // Throws an error if directory does not exist
    try {
      git = Git(localPath(blogID, "/"));
    } catch (err) {
      return callback(err);
    }

    // Make sure we push to the bare repository, even if the checkout's origin
    // has gone stale (sync does the same). We do this before touching the
    // blog folder, so if it fails the checkout is left as it was.
    //
    // Required here because models/blog requires renameRepo, which requires
    // this module.
    require("models/blog").get({ id: blogID }, function (err, blog) {
      if (err) return callback(err);

      if (!blog) return callback(new Error("No blog with ID " + blogID));

      pointOriginAtBareRepo(git, blog.handle, function (err) {
        if (err) return callback(err);

        var changeFile =
          contents === null
            ? function (callback) {
                fs.remove(localPath(blogID, path), callback);
              }
            : function (callback) {
                fs.outputFile(localPath(blogID, path), contents, callback);
              };

        changeFile(function (err) {
          if (err) return callback(err);

          // Git does not like paths with leading slashes
          if (path[0] === "/") path = path.slice(1);

          // Could we queue these commands for better performance?
          git.raw(["add", "--", path], function (err) {
            // If a removed path was not tracked by git, no worries.
            // The message has a trailing newline so we trim it and check
            // against this template. This doesn't feel *robust* but it
            // seems to work.
            if (
              contents === null &&
              err &&
              err.message.trim() ===
                "fatal: pathspec '" + path + "' did not match any files"
            ) {
              return callback(null);
            }

            if (err) return callback(err);

            var message = (contents === null ? "Removed " : "Updated ") + path;

            // Blot applies this change itself, so the commit counts as
            // applied too, see advanceApplied below. A repository with no
            // commit yet has no parent: the recorded commit is left alone.
            git.raw(["rev-parse", "HEAD"], function (err, parent) {
              parent = err ? "" : parent.trim();

              git.raw(["commit", "-m", message], function (err) {
                if (err) return callback(err);

                // We push changes made to the bare repository, holding the
                // lock a user's push holds to move the refs, so the two
                // never move them at once
                pushUnderRefLock(git, blogID, function (err) {
                  if (err) return callback(err);

                  debug("Blog:", blogID, "Committed", path);
                  advanceApplied(git, blogID, parent, callback);
                });
              });
            });
          });
        });
      });
    });
  });
}

function pushUnderRefLock(git, blogID, callback) {
  holdRefLock(blogID).then(function (release) {
    git.raw(["push"], function (err) {
      release().then(
        function () {
          process.nextTick(callback, err);
        },
        function (releaseErr) {
          // The lock expires by itself; a push that worked still worked
          console.error(clfdate(), "Git: could not release the ref lock of", blogID, releaseErr.message);
          process.nextTick(callback, err);
        }
      );
    });
  }, function (err) {
    process.nextTick(callback, err);
  });
}

// Moves the blog's recorded applied commit to the commit just made, but only
// if it is still the commit's parent. If it is something else, an earlier
// push has not been applied, and Blot's change is left for the next sync to
// apply again, which is harmless. Redis being unavailable is no reason to
// fail a write that is already pushed, for the same reason.
function advanceApplied(git, blogID, parent, callback) {
  git.raw(["rev-parse", "HEAD"], function (err, head) {
    head = err ? "" : head.trim();

    if (!parent || !head || head === parent) return callback(null);

    database.advanceApplied(blogID, parent, head, function (err) {
      if (err) debug("Blog:", blogID, "Could not record applied commit", err);
      callback(null);
    });
  });
}

module.exports = {
  directory: directory,
  exists: exists,
  handleSmartHttp: handleSmartHttp,
  onPush: onPush,
  commit: commit,
  pointOriginAtBareRepo: pointOriginAtBareRepo,
};
