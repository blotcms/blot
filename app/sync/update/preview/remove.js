var drafts = require("../drafts");
var previewPath = drafts.previewPath;
var Blog = require("models/blog");
var blogFolder = require("clients/folder");
var callbackify = require("util").callbackify;

module.exports = function (blogID, path, callback) {
  callback = callback || function () {};

  Blog.get({ id: blogID }, function (err, blog) {
    if (err) return callback(err);

    if (!blog.client) return callback();

    var preview_path = previewPath(path);

    callbackify(blogFolder.remove)(blog, preview_path, function (err) {
      callback(err || null);
    });
  });
};
