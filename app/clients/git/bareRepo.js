var fs = require("fs-extra");
var debug = require("debug")("blot:clients:git:bareRepo");
var dataDir = require("./dataDir");
var Blog = require("models/blog");

// Where a blog's bare repository lives, given its git handle
function directory(handle) {
  return dataDir + "/" + handle + ".git";
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

    git.remote(["set-url", "origin", bareRepoDirectory], function (err) {
      // simple-git returns errors as strings
      if (err) return callback(new Error(err));

      callback(null);
    });
  });
}

// As above, for callers that only know the blog's ID, such as the
// client's write and remove methods. Also errors if the blog is missing.
function pointOriginAtBareRepoForBlog(git, blogID, callback) {
  Blog.get({ id: blogID }, function (err, blog) {
    if (err) return callback(err);

    if (!blog) return callback(new Error("No blog with ID " + blogID));

    pointOriginAtBareRepo(git, blog.handle, callback);
  });
}

module.exports = {
  directory: directory,
  pointOriginAtBareRepo: pointOriginAtBareRepo,
  pointOriginAtBareRepoForBlog: pointOriginAtBareRepoForBlog,
};
