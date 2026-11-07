// The one place that knows how a blog's repository is served, written to and
// watched, so the rest of the git client asks for what it wants (serve this
// request, a push happened, commit this change, remove the repository) and
// does not talk to git's protocol or the store.
//
// The repository is in the git store (store/, served/), under <blogID>/git/
// in the storage bucket, keyed by the blog's ID: a change of handle moves
// nothing.
var lock = require("helper/lock");
var clfdate = require("helper/clfdate");
var treePath = require("./store/commit").treePath;

// Set with onPush
var pushed = function () {};
var prepare = null;
var abandon = null;

// The short lock on a blog's refs. It is held to move refs, by a push which
// has already been received and checked, by Blot's own commit and by a
// compaction, and never while a push is being received, so it is nothing like
// the sync's folder lock, which Blot's commits happen inside of. It expires by
// itself after a few seconds if the process holding it dies.
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
      console.error(
        clfdate(),
        "Git: lost the ref lock of",
        blogID,
        err.message
      );
    },
  }).then(function (held) {
    return held.release;
  });
}

// What a push needs from the rest of Blot, see served/receive.js
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

// Resolves to whether the blog has a repository in the store: one which
// is not empty. A failure to read the store is passed on.
async function exists(blogID) {
  var manifest = require("./store/manifest");
  var store = require("./served/context").storeFor(blogID);

  var current = await manifest.read(store);

  return !manifest.isEmpty(current);
}

// Serves a smart HTTP request (ref advertisement, fetch, push) for the blog's
// repository, from the store (served/reads.js; a push goes to
// served/receive.js). The request has been authenticated as having access to
// the blog, and its URL names the blog's current handle (req.gitHandle).
function handleSmartHttp(req, res, blogID, blog) {
  req.blogID = blogID;

  return require("./served/reads").handle(req, res, blog || { id: blogID }, {
    receive: function (req, res, blog) {
      return require("./served/receive").handle(
        req,
        res,
        blog,
        receiveHooks(blogID)
      );
    },
  });
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

// Removes the blog's repository from the store (served/remove.js). Never
// rejects: a failure is logged, and the monthly orphan sweep deletes what is
// left.
async function remove(blogID) {
  var removeBlog;

  try {
    removeBlog = require("./served/remove").removeBlog;
  } catch (err) {
    console.error(
      clfdate(),
      "[git-store-served] blog=" + blogID,
      "could not remove the store copy:",
      err.message
    );
    return;
  }

  try {
    await removeBlog(blogID);
  } catch (err) {
    // Never fails the caller
  }
}

// Makes one change to the blog's repository: writes the file, or removes it
// if contents is null, as a commit on master. Used by the client's write and
// remove methods.
//
//   await commit(blogID, { path: "/a.txt", contents: "A" })
//
// The file is changed in the blog folder too, before the commit. Only the
// file is, nothing else in the folder. See served/commit.js.
async function commit(blogID, change) {
  // Before anything is touched
  treePath(change.path);

  await require("./served/commit")(blogID, change);
}

const promiseOnly = require("helper/promiseOnly");

module.exports = {
  exists: promiseOnly(exists),
  remove: promiseOnly(remove),
  handleSmartHttp: handleSmartHttp,
  onPush: onPush,
  commit: promiseOnly(commit),
  holdRefLock: holdRefLock,
  receiveHooks: receiveHooks,
};
