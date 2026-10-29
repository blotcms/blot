var joinpath = require("path").join;
var isOwner = require("./isOwner");
var localPath = require("helper/localPath");
var fs = require("fs-extra");
var getAllViews = require("./getAllViews");
var determineTemplateFolder = require("./determineTemplateFolder");
var withFolderLock = require("./withFolderLock");

function removeFromFolderUnlocked (blogID, templateID, callback) {
  isOwner(blogID, templateID, function (err, owner) {
    if (err) return callback(err);

    if (!owner) return callback(null);

    getAllViews(templateID, function (err, views, metadata) {
        if (err) return callback(err);
  
        if (!views || !metadata || !metadata.localEditing) return callback(null);
  
      makeClient(blogID, function (err, client) {
        if (err) {
          return callback(err);
        }

        determineTemplateFolder(blogID, function (folderErr, folderName) {
          if (folderErr) {
            return callback(folderErr);
          }

          var dir = joinpath(folderName, metadata.slug);
          
          client.remove(blogID, dir, callback);
        });
      });
    });
});
}

function makeClient (blogID, callback) {
  require("models/blog").get({ id: blogID }, function (err, blog) {
    var client = require("clients")[blog.client];

    // we create a fake client to write the template files directly
    // to the blog's folder if the user has not configured a client
    if (!blog.client || !client) {
      return callback(null, {
        remove: function (blogID, path, callback) {
          fs.remove(localPath(blogID, path), callback);
        },
        write: function (blogID, path, content, callback) {
          fs.outputFile(localPath(blogID, path), content, callback);
        }
      });
    }

    return callback(null, client, blog.template);
  });
}

module.exports = withFolderLock(removeFromFolderUnlocked);
