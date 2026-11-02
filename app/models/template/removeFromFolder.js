var joinpath = require("path").join;
var isOwner = require("./isOwner");
var blogFolder = require("clients/folder");
var callbackify = require("util").callbackify;
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
