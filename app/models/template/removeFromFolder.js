var joinpath = require("path").join;
var isOwner = require("./isOwner");
var blogFolder = require("clients/folder");
var callbackify = require("util").callbackify;
var getAllViews = require("./getAllViews");
var withCallback = require("helper/withCallback");
var determineTemplateFolder = require("./determineTemplateFolder");
var withFolderLock = require("./withFolderLock");

function removeFromFolderUnlocked(blogID, templateID, callback) {
  isOwner(blogID, templateID, function (err, owner) {
    if (err) return callback(err);

    if (!owner) return callback(null);

    withCallback(getAllViews)(templateID, function (err, result) {
      if (err) return callback(err);

      var views = result.views;
      var metadata = result.metadata;

      if (!views || !metadata || !metadata.localEditing) return callback(null);

      determineTemplateFolder(blogID, function (folderErr, folderName) {
        if (folderErr) {
          return callback(folderErr);
        }

        var dir = joinpath(folderName, metadata.slug);

        callbackify(blogFolder.remove)(blogID, dir, callback);
      });
    });
  });
}

module.exports = withFolderLock(removeFromFolderUnlocked);
