var drafts = require("../drafts");
var previewPath = drafts.previewPath;
var Blog = require("models/blog");
var blogFolder = require("clients/folder");

// Callers that do not wait for this (the old callback was optional) must
// catch its rejection themselves.
module.exports = async function write(blogID, path) {
  var blog = await Blog.get({ id: blogID });

  var preview_path = previewPath(path);

  var contents = await drafts.previewFile(blog.handle, path);

  // A blog with no client is written directly, which helps
  // in writing tests for client-less blogs
  await blogFolder.write(blog, preview_path, contents);
};
