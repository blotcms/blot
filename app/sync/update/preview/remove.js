var drafts = require("../drafts");
var previewPath = drafts.previewPath;
var Blog = require("models/blog");
var blogFolder = require("clients/folder");
var withCallback = require("helper/withCallback");

// Callers that do not wait for this (the old callback was optional) must
// catch its rejection themselves.
module.exports = withCallback(async function remove(blogID, path) {
  var blog = await Blog.get({ id: blogID });

  if (!blog.client) return;

  await blogFolder.remove(blog, previewPath(path));
});
