var { callbackify } = require("util");
var folder = require("storage/folder");
var Blog = require("models/blog");
var User = require("models/user");
var debug = require("debug")("blot:clients:git:disconnect");
var database = require("./database");
var repo = require("./repo");
var shadow = require("./shadow/hook");

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

// Called when the user disconnects the client, and when the blog is deleted.
// It needs nothing from the blog folder, so a blog whose folder is already
// gone is disconnected, and its repository removed, all the same.
module.exports = function disconnect(blogID, callback) {
  // TODO, this shit should be handled at the next layer up
  // we shouldn't worry about setting blog.client to ""
  Blog.get({ id: blogID }, function (err, blog) {
    if (err || !blog) {
      return callback(err || new Error("No blog"));
    }

    Blog.set(blogID, { client: "" }, function (err) {
      if (err) return callback(err);

      // The blog's copy in the git store, from shadow mode, if it ever had
      // one. After the client is unset, so no other process starts writing
      // to it again. Never fails the disconnect.
      shadow.remove(blog.id, function () {
        removeRepository(blog, callback);
      });
    });
  });
};

function removeRepository(blog, callback) {
  database.removeStatus(blog.id, function (err) {
    if (err) return callback(err);
    // Remove the bare git repo, at the blog's current handle. A repo at
    // a former handle is not this blog's to remove: only a push to the
    // current handle is served, and a repo left at an old one could be
    // another blog's.
    repo.remove(blog.handle, function (err) {
      if (err) return callback(err);

      // Remove the live clone, the .git directory in the blog folder,
      // which blogs made before Blot stopped committing in it have.
      // Remove this with the live clones.
      callbackify(folder.remove)(blog.id, "/.git", function (err) {
        if (err) return callback(err);

        // A later connection starts its own history
        database.removeApplied(blog.id, function (err) {
          if (err) return callback(err);

          // Last, so a failed lookup leaves an unused token, not a repo
          flushTokenIfUnused(blog, callback);
        });
      });
    });
  });
}
