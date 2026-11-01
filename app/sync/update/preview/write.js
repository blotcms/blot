var drafts = require("../drafts");
var previewPath = drafts.previewPath;
var Blog = require("models/blog");
var storage = require("storage/folder");
var callbackify = require("util").callbackify;

module.exports = function (blogID, path, callback) {
  callback = callback || function () {};

  var clients = require("clients");

  Blog.get({ id: blogID }, function (err, blog) {
    if (err) return callback(err);

    var preview_path = previewPath(path);

    drafts.previewFile(blog.handle, path, function (err, contents) {
      if (err) return callback(err);

      var client = clients[blog.client];

      // if the blog has no client, we write directly to the
      // blog folder on disk. This helps in writing tests
      // for client-less blogs
      if (client) {
        client.write(blogID, preview_path, contents, callback);
      } else {
        callbackify(storage.write)(blogID, preview_path, contents, callback);
      }
    });
  });
};
