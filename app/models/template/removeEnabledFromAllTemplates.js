var async = require("async");
var joinpath = require("path").join;
var folder = require("storage/folder");
var blogFolder = require("clients/folder");
var callbackify = require("util").callbackify;
var determineTemplateFolder = require("./determineTemplateFolder");
var shouldIgnoreFile = require("clients/util/shouldIgnoreFile");
var getMetadata = require("./getMetadata");
var makeID = require("./util/makeID");
var writeToFolder = require("./writeToFolder");

var PACKAGE = "package.json";

function removeEnabledFromAllTemplates(blogID, callback) {
  determineTemplateFolder(blogID, function (err, folderName) {
    if (err) return callback(err);
    removeEnabledFromAllTemplatesInFolder(blogID, folderName, callback);
  });
}

function removeEnabledFromAllTemplatesInFolder(blogID, folderName, callback) {
  callbackify(folder.listNames)(blogID, folderName, function (err, listing) {
    if (err) {
      if (err.code === "ENOENT" || err.code === "ENOTDIR") return callback(null, []);
      return callback(err);
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

    async.eachSeries(
      entries,
      function (entry, next) {
        if (!entry || entry[0] === "." || shouldIgnoreFile(entry)) {
          return next();
        }

        var packagePath = joinpath(folderName, entry, PACKAGE);

        callbackify(folder.read)(blogID, packagePath, function (err, buffer) {
          if (err) {
            if (err.code === "ENOENT") return next();
            errors.push(err);
            return next();
          }

          var data;

          try {
            data = JSON.parse(buffer.toString("utf-8"));
          } catch (parseErr) {
            errors.push(parseErr);
            return next();
          }

          if (!data || data.enabled !== true) return next();

          data.enabled = false;
          var updated = JSON.stringify(data, null, 2);

          // Through the client, so the provider gets the change too
          callbackify(blogFolder.write)(blogID, packagePath, updated, function (err) {
            if (err) {
              errors.push(err);
              return next();
            }

            modifiedSlugs.push(entry);

            // Check if this template is locally-edited and write it back to the folder
            var templateID = makeID(blogID, entry);
            getMetadata(templateID, function (err, metadata) {
              if (err || !metadata || !metadata.localEditing) {
                return next();
              }

              writeToFolder(blogID, templateID, function (writeErr) {
                if (writeErr) {
                  console.warn(
                    "Failed to write modified template to folder",
                    blogID,
                    templateID,
                    writeErr
                  );
                }
                next();
              });
            });
          });
        });
      },
      function (err) {
        if (err) errors.push(err);
        if (errors.length) {
          var aggregate = new Error(
            "Failed to update one or more template packages."
          );
          aggregate.errors = errors;
          return callback(aggregate, modifiedSlugs);
        }

        callback(null, modifiedSlugs);
      }
    );
  });
}

module.exports = removeEnabledFromAllTemplates;
