var drafts = require("../drafts");
var previewPath = drafts.previewPath;
var Blog = require("models/blog");
var blogFolder = require("clients/folder");

// Callers that do not wait for this (the old callback was optional) must
// catch its rejection themselves.
module.exports = async function remove(blogID, path) {
  var blog = await Blog.get({ id: blogID });

  if (!blog.client) return;

  await blogFolder.remove(blog, previewPath(path));
};
