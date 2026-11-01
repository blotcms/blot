// The one place that knows where a blog's bare repository is and how it is
// served, written to and watched, so the rest of the git client asks for what
// it wants (serve this request, a push happened, commit this change) and does
// not build paths or talk to pushover.
//
// Repositories are keyed by the blog's handle for now, so the functions that
// are not about one blog take the handle.
var fs = require("fs-extra");
var debug = require("debug")("blot:clients:git:repo");
var localPath = require("helper/localPath");
var Git = require("./git");
var dataDir = require("./dataDir");
var checkGitRepoExists = require("./checkGitRepoExists");
var smartHttp = require("./smartHttp");

// Must come before pushover is used. Gives every Git request's duplex an
// "error" listener so an aborted request can never be an unhandled error.
require("./guardServices");

var pushover = require("pushover");

var repos = pushover(dataDir, { autoCreate: false });

repos.on("error", function (err) {
  if (err && (err.code === "ECONNRESET" || err.code === "EPIPE")) {
    return debug("Git repos connection error", err.message || err);
  }

  debug("Git repos error", err);
});

// Tags and fetches have no special handling: pushover accepts them when nobody
// is listening, so keep doing exactly that, explicitly. Errors on these (and on
// every other Git request) are handled for all requests in guardServices.js and
// in routes.js.
["tag", "fetch"].forEach(function (eventName) {
  repos.on(eventName, function (service) {
    debug("Git " + eventName);
    service.accept();
  });
});

// Called with (blogID, old, new) once a push has been accepted and finished.
// Set with onPush.
var pushed = function () {};

repos.on("push", function (push) {
  if (push && push.branch && push.branch !== "master") {
    return push.reject(
      400,
      "Push rejected: only the master branch is allowed. Please push to master or open a PR."
    );
  }

  push.accept();

  // This might cause an interesting race condition. It happened for me during
  // testing. If we invoke Blog.Sync right now, it should be fine but previously
  // I had an additional asynchronous database lookup to fetch the full blog. I
  // believe this triggered issues in testing, because the test checked to see
  // if a sync had finished that had not actually yet begun. Perhaps we should
  // begin the sync on the "send" event instead of the "finish" event? That
  // might give us a firmer guarantee that the order of events is correct. This
  // seems to be purely a problem for automated use of the git client, humans
  // are unlikely to fire off multiple pushes immediately after the other.
  var notified = false;

  function notify() {
    if (notified) return;
    notified = true;

    // I'm not sure what happens to lead to this being invoked
    // without a request or blog but it do sometimes.
    if (!push || !push.request || !push.request.blogID)
      return debug("No blog found for push", push);

    pushed(push.request.blogID, push.last, push.commit);
  }

  push.response.on("finish", notify);

  // "finish" never fires for a client which hangs up as soon as it has read
  // the push's result, as libgit2 can, and the commit would then sit unsynced
  // until the next push. git-receive-pack exiting cleanly means the refs are
  // updated. An aborted push can exit cleanly too, having changed nothing,
  // and then this is a sync with nothing to do.
  push.on("service", function (ps) {
    ps.once("exit", function (code) {
      if (code === 0) notify();
    });
  });
});

// Where a blog's bare repository lives, given its git handle
function directory(handle) {
  return dataDir + "/" + handle + ".git";
}

function exists(handle, callback) {
  repos.exists(handle + ".git", callback);
}

// Serves a smart HTTP request (ref advertisement, fetch, push) for the blog's
// repository. The request has been authenticated as having access to the
// blog, and its URL names the blog's current handle (req.gitHandle). Fetches
// are served by smartHttp.js and anything else by pushover, which finds the
// repository from the URL.
function handleSmartHttp(req, res, blogID) {
  req.blogID = blogID;

  if (smartHttp.handle(req, res, directory(req.gitHandle))) return;

  // We need to pause then resume for some strange reason. See Pushover issue #30.
  req.pause();
  repos.handle(req, res);
  req.resume();
}

function onPush(callback) {
  pushed = callback;
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

            git.raw(["commit", "-m", message], function (err) {
              if (err) return callback(err);

              // We push changes made to the bare repository
              git.raw(["push"], function (err) {
                if (err) return callback(err);

                debug("Blog:", blogID, "Committed", path);
                callback(null);
              });
            });
          });
        });
      });
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
