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
function pointOriginAtBareRepo(git, handle, callback) {
  git.remote(["set-url", "origin", directory(handle)], function (err) {
    // simple-git returns errors as strings
    if (err) return callback(new Error(err));

    callback(null);
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
