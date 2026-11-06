var drafts = require("../drafts");
var previewPath = drafts.previewPath;
var Blog = require("models/blog");
var blogFolder = require("clients/folder");
var callbackify = require("util").callbackify;

module.exports = function (blogID, path, callback) {
  callback = callback || function () {};

  Blog.get({ id: blogID }, function (err, blog) {
    if (err) return callback(err);

    var preview_path = previewPath(path);

    drafts.previewFile(blog.handle, path, function (err, contents) {
      if (err) return callback(err);

      // A blog with no client is written directly, which helps
      // in writing tests for client-less blogs
      callbackify(blogFolder.write)(
        blog,
        preview_path,
        contents,
        function (err) {
          callback(err || null);
        }
      );
    });
  });
};
