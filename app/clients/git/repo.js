// The one place that knows where a blog's bare repository is and how it is
// served, written to and watched, so the rest of the git client asks for what
// it wants (serve this request, a push happened, commit this change, remove
// the repository) and does not build paths or talk to git's protocol.
//
// Repositories are keyed by the blog's handle for now, so the functions that
// are not about one blog take the handle.
var fs = require("fs-extra");
var debug = require("debug")("blot:clients:git:repo");
var folder = require("storage/folder");
var lock = require("helper/lock");
var clfdate = require("helper/clfdate");
var Git = require("./git");
var plumbing = require("./plumbing");
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

// Removes a blog's bare repository, given its git handle. Calls back whether or
// not there was one. The handle names a directory in the data directory and
// nothing else: a handle which could name another place is refused.
function remove(handle, callback) {
  // A blog without a handle has no repository
  if (!handle) return process.nextTick(callback, null);

  if (
    typeof handle !== "string" ||
    handle === "." ||
    handle === ".." ||
    /[\/\\\0]/.test(handle)
  )
    return process.nextTick(callback, new Error("Invalid Git handle: " + handle));

  fs.remove(directory(handle), callback);
}

// Older blogs have a live clone: a second repository in the blog folder's .git
// directory, which Blot's commits used to be made in and pushed from. Blogs
// made since never had one, and nothing relies on it now, so all that is left
// here is keeping it at master, so that it works again if this code is rolled
// back (Blot's commit would otherwise be made on a stale HEAD and refused as
// not a fast-forward). Remove it with the clones.
//
// It pushes to and fetches from its 'origin' remote, which should be the bare
// repository. The stored URL can go stale (for example if the data directory
// has moved), so we reset it before talking to the remote.
//
// We only do so if the bare repository exists at the path. When a blog's
// handle changes, the bare repository is renamed just before the new handle is
// saved, so for a moment the blog's saved handle, which we look up, has no
// repository (it is at the new handle). In that case
// 'origin' is left alone: the next sync or commit fixes it.
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

// Moves the live clone's HEAD and index to the commit without touching the
// blog folder (a mixed reset), after fetching it from the bare repository.
function followLiveClone(git, handle, commit, callback) {
  pointOriginAtBareRepo(git, handle, function (err) {
    if (err) return callback(err);

    // No automatic gc or maintenance afterwards. A fetch of a few objects from
    // a local repository leaves them loose, so over many syncs and Blot writes
    // a clone passes gc's threshold, and then every fetch starts a detached
    // repack of the whole clone. Git 2.54 lets those overlap, and on 2 Nov
    // 2026 that left seven full copies of a 5 GB clone (#2259). Nothing reads
    // the clone's objects, so they are never packed.
    git.raw(["-c", "gc.auto=0", "-c", "maintenance.auto=false", "fetch", "--all"], function (err) {
      if (err) return callback(err);

      git.raw(["reset", "--mixed", "--quiet", commit], function (err) {
        callback(err || null);
      });
    });
  });
}

// Moves the blog's live clone, if it has one, to the commit. Nothing depends
// on it, so a failure is logged and not passed on.
function followLiveCloneIfAny(blogID, handle, commit, callback) {
  checkGitRepoExists(blogID, function (err, blogDirectory) {
    if (err) return callback();

    var git;

    try {
      git = Git(blogDirectory);
    } catch (err) {
      return callback();
    }

    followLiveClone(git, handle, commit, function (err) {
      if (err) console.error(clfdate(), "Git: could not move the live clone of", blogID, err.message);
      callback();
    });
  });
}

// Makes one change to the blog's repository: writes the file, or removes it
// if contents is null, as a commit on master of the bare repository. Used by
// the client's write and remove methods.
//
//   commit(blogID, { path: "/a.txt", contents: "A" }, callback)
//
// The file is changed in the blog folder too, before the commit, as it always
// was. Only the file is, nothing else in the folder.
//
// The commit is made while holding the ref lock a user's push holds to move
// master, so the two never move it at once, and it moves master only from the
// commit it was made on (see plumbing.js). If master has moved by then the
// change is made again on the new master, a few times, and then the write
// fails: the push that moved it is never replaced, and the file stays in the
// blog folder, which is where a write that failed to commit has always left it.
//
// A change that leaves the tree as it is (the same contents again, or a removal
// of a file the repository doesn't have) makes no commit.
function commit(blogID, change, callback) {
  commitChange(blogID, change).then(
    function () {
      process.nextTick(callback, null);
    },
    function (err) {
      process.nextTick(callback, err);
    }
  );
}

async function commitChange(blogID, change) {
  var path = change.path;
  var contents = change.contents;

  // Before anything is touched
  plumbing.treePath(path);

  // Required here because models/blog requires renameRepo, which requires
  // this module.
  var blog = await new Promise(function (resolve, reject) {
    require("models/blog").get({ id: blogID }, function (err, blog) {
      if (err) return reject(err);
      if (!blog) return reject(new Error("No blog with ID " + blogID));
      resolve(blog);
    });
  });

  var bareRepoDirectory = directory(blog.handle);

  if (!(await fs.pathExists(bareRepoDirectory)))
    throw new Error("The Git repository of " + blogID + " does not exist at " + bareRepoDirectory);

  if (contents === null) {
    await folder.remove(blogID, path);
  } else {
    await folder.write(blogID, path, contents);
  }

  var release = await holdRefLock(blogID);
  var result;

  try {
    result = await plumbing.commitFile(bareRepoDirectory, change);
  } finally {
    try {
      await release();
    } catch (err) {
      // The lock expires by itself; a commit that worked still worked
      console.error(clfdate(), "Git: could not release the ref lock of", blogID, err.message);
    }
  }

  if (!result.commit) return;

  debug("Blog:", blogID, "Committed", path);

  plumbing.collect(bareRepoDirectory);

  await advanceApplied(blogID, result.parent, result.commit);
  await new Promise(function (resolve) {
    followLiveCloneIfAny(blogID, blog.handle, result.commit, resolve);
  });
}

// Moves the blog's recorded applied commit to the commit just made, but only
// if it is still the commit's parent. If it is something else, an earlier
// push has not been applied, and Blot's change is left for the next sync to
// apply again, which is harmless. Redis being unavailable is no reason to
// fail a write that is already committed, for the same reason.
function advanceApplied(blogID, parent, commit) {
  return new Promise(function (resolve) {
    // The repository's first commit has no parent
    if (!parent) return resolve();

    database.advanceApplied(blogID, parent, commit, function (err) {
      if (err) debug("Blog:", blogID, "Could not record applied commit", err);
      resolve();
    });
  });
}

module.exports = {
  directory: directory,
  exists: exists,
  remove: remove,
  handleSmartHttp: handleSmartHttp,
  onPush: onPush,
  commit: commit,
  holdRefLock: holdRefLock,
  pointOriginAtBareRepo: pointOriginAtBareRepo,
  followLiveClone: followLiveClone,
};
