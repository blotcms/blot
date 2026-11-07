var joinpath = require("path").join;
var isOwner = require("./isOwner");
var blogFolder = require("clients/folder");
var getAllViews = require("./getAllViews");
var promiseOnly = require("helper/promiseOnly");
var determineTemplateFolder = require("./determineTemplateFolder");
var withFolderLock = require("./withFolderLock");

async function removeFromFolderUnlocked(blogID, templateID) {
  var owner = await isOwner(blogID, templateID);

  if (!owner) return;

  var result = await getAllViews(templateID);
  var views = result.views;
  var metadata = result.metadata;

  if (!views || !metadata || !metadata.localEditing) return;

  var folderName = await determineTemplateFolder(blogID);
  var dir = joinpath(folderName, metadata.slug);

  return blogFolder.remove(blogID, dir);
}

module.exports = promiseOnly(withFolderLock(removeFromFolderUnlocked));
