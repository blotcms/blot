var fs = require("fs-extra");
var localPath = require("helper/localPath");
var Blog = require("models/blog");
var User = require("models/user");
var Git = require("simple-git");
var debug = require("debug")("blot:clients:git:disconnect");
var database = require("./database");
var dataDir = require("./dataDir");

// The git token is account-wide: every site the owner has connected to
// git shares it, so it can only be flushed with the owner's last git site.
function flushTokenIfUnused(blog, callback) {
  User.getById(blog.owner, function (err, user) {
    if (err) return callback(err);

    var otherBlogIDs = ((user && user.blogs) || []).filter(function (id) {
      return id !== blog.id;
    });

    (function next() {
      var id = otherBlogIDs.shift();

      if (!id) return database.flush(blog.owner, callback);

      Blog.get({ id: id }, function (err, otherBlog) {
        if (err) return callback(err);
        if (otherBlog && otherBlog.client === "git") return callback();
        next();
      });
    })();
  });
}

// Called when the user disconnects the client
// This may occur when the
module.exports = function disconnect(blogID, callback) {
  var liveRepoDirectory = localPath(blogID, "/");
  var liveRepo;

  // Throws an error if directory does not exist
  try {
    liveRepo = Git(liveRepoDirectory).silent(true);
  } catch (err) {
    return callback(err);
  }

  // TODO, this shit should be handled at the next layer up
  // we shouldn't worry about setting blog.client to ""
  Blog.get({ id: blogID }, function (err, blog) {
    if (err || !blog) {
      return callback(err || new Error("No blog"));
    }

    Blog.set(blogID, { client: "" }, function (err) {
      if (err) return callback(err);

      database.removeStatus(blog.id, function (err) {
        if (err) return callback(err);
        // Remove the bare git repo in /repos
        fs.remove(dataDir + "/" + blog.handle + ".git", function (err) {
          if (err) return callback(err);

          // Remove the .git directory in the user's blog folder?
          // maybe don't do this... they might want it...
          // what if there was a repo in their folder beforehand?
          fs.remove(localPath(blogID, "/.git"), function (err) {
            if (err) return callback(err);

            // Last, so a failed lookup leaves an unused token, not a repo
            flushTokenIfUnused(blog, callback);
          });
        });
      });
    });
  });
};
