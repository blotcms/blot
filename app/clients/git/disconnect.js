var folder = require("storage/folder");
var Blog = require("models/blog");
var User = require("models/user");
var database = require("./database");
var repo = require("./repo");
var withCallback = require("helper/withCallback");

// The git token is account-wide: every site the owner has connected to
// git shares it, so it can only be flushed with the owner's last git site.
async function flushTokenIfUnused(blog) {
  var user = await User.getById(blog.owner);

  var otherBlogIDs = ((user && user.blogs) || []).filter(function (id) {
    return id !== blog.id;
  });

  for (var id of otherBlogIDs) {
    var otherBlog = await Blog.get({ id: id });
    if (otherBlog && otherBlog.client === "git") return;
  }

  await database.flush(blog.owner);
}

// Called when the user disconnects the client, and when the blog is deleted.
// It needs nothing from the blog folder, so a blog whose folder is already
// gone is disconnected, and its repository removed, all the same.
async function disconnect(blogID) {
  // TODO, this shit should be handled at the next layer up
  // we shouldn't worry about setting blog.client to ""
  var blog = await Blog.get({ id: blogID });

  if (!blog) throw new Error("No blog");

  await Blog.set(blogID, { client: "" });

  // The blog's repository in the git store. After the client is unset,
  // so no other process starts writing to it again. Never fails the
  // disconnect.
  await repo.remove(blog.id);

  await removeRepository(blog);
}

async function removeRepository(blog) {
  // The setup status is the owner's (create.js writes it under blog.owner),
  // and the mark of a setup in progress the blog's
  await database.removeStatus(blog.owner);
  await database.clearCreating(blog.id);

  await removeLiveClone(blog);
}

// Removes the live clone, the .git directory in the blog folder, which blogs
// made before Blot stopped committing in it have, then the applied commit and,
// with the owner's last git site, the token
async function removeLiveClone(blog) {
  await folder.remove(blog.id, "/.git");

  // A later connection starts its own history
  await database.removeApplied(blog.id);

  // Last, so a failed lookup leaves an unused token, not a repo
  await flushTokenIfUnused(blog);
}

module.exports = withCallback(disconnect);
