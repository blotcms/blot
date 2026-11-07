var joinpath = require("path").join;
var folder = require("storage/folder");
var blogFolder = require("clients/folder");
var determineTemplateFolder = require("./determineTemplateFolder");
var shouldIgnoreFile = require("clients/util/shouldIgnoreFile");
var getMetadata = require("./getMetadata");
var makeID = require("./util/makeID");
var writeToFolder = require("./writeToFolder");

var PACKAGE = "package.json";

// Calls back (err, modifiedSlugs): when some packages couldn't be updated,
// err is an aggregate error and modifiedSlugs still lists the ones that were.
function removeEnabledFromAllTemplates(blogID, callback) {
  run(blogID).then(function (result) {
    callback(result.err, result.modifiedSlugs);
  }, callback);
}

async function run(blogID) {
  var folderName = await determineTemplateFolder(blogID);
  var listing;

  try {
    listing = await folder.listNames(blogID, folderName);
  } catch (err) {
    if (err.code === "ENOENT" || err.code === "ENOTDIR")
      return { err: null, modifiedSlugs: [] };
    throw err;
  }

  var errors = [];
  var modifiedSlugs = [];

  // Only directories hold templates (listings leave out symbolic links)
  var entries = listing
    .filter(function (entry) {
      return entry.isDirectory;
    })
    .map(function (entry) {
      return entry.name;
    });

  for (var entry of entries) {
    if (!entry || entry[0] === "." || shouldIgnoreFile(entry)) continue;

    var packagePath = joinpath(folderName, entry, PACKAGE);
    var buffer;

    try {
      buffer = await folder.read(blogID, packagePath);
    } catch (err) {
      if (err.code !== "ENOENT") errors.push(err);
      continue;
    }

    var data;

    try {
      data = JSON.parse(buffer.toString("utf-8"));
    } catch (parseErr) {
      errors.push(parseErr);
      continue;
    }

    if (!data || data.enabled !== true) continue;

    data.enabled = false;
    var updated = JSON.stringify(data, null, 2);

    // Through the client, so the provider gets the change too
    try {
      await blogFolder.write(blogID, packagePath, updated);
    } catch (err) {
      errors.push(err);
      continue;
    }

    modifiedSlugs.push(entry);

    // Check if this template is locally-edited and write it back to the folder
    var templateID = makeID(blogID, entry);
    var metadata = await getMetadata(templateID).catch(function () {});

    if (!metadata || !metadata.localEditing) continue;

    try {
      await writeToFolder(blogID, templateID);
    } catch (writeErr) {
      console.warn(
        "Failed to write modified template to folder",
        blogID,
        templateID,
        writeErr
      );
    }
  }

  if (errors.length) {
    var aggregate = new Error(
      "Failed to update one or more template packages."
    );
    aggregate.errors = errors;
    return { err: aggregate, modifiedSlugs: modifiedSlugs };
  }

  return { err: null, modifiedSlugs: modifiedSlugs };
}

module.exports = removeEnabledFromAllTemplates;
