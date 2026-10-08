var fs = require("fs-extra");
var basename = require("path").basename;
var getMetadata = require("./getMetadata");
var setMetadata = require("./setMetadata");
var getView = require("./getView");
var async = require("async");
var makeID = require("./util/makeID");
var setView = require("./setView");
const shouldIgnoreFile = require("clients/util/shouldIgnoreFile");
var MAX_SIZE = 2.5 * 1000 * 1000; // 2.5mb
var PACKAGE = "package.json";
var savePackage = require("./package").save;
var client = require("models/client");
var key = require("./key");
var dropView = require("./dropView");
const Blog = require("models/blog");
const create = require("./create");
const improveJSONErrorMessage = require("./util/improveJSONErrorMessage");
const improveMustacheErrorMessage = require("./util/improveMustacheErrorMessage");

module.exports = function readFromFolder (blogID, dir, callback) {
  // check the directory exists
  fs.readdir(dir, function (err, contents) {
    if (err) return callback(err);

    if (!contents || !contents.length)
      return callback(new Error("No files found in " + dir));

    var id = makeID(blogID, basename(dir));

    getMetadata(id, function (err, template) {
      // Only a missing template is created here. Any other error (e.g. Redis
      // unavailable) must reach the callback, or buildFromFolder stalls and
      // the sync never releases the folder lock.
      if (err && err.code !== "ENOENT") return callback(err);
      if (template) return readTemplate();

      create(blogID, basename(dir), { slug: basename(dir) }, function (err) {
        if (err) return callback(err);
        readTemplate();
      });
    });

    function readTemplate () {
      loadPackage(id, dir, function (err, views, enabled) {
        const errors = {};

        if (err) {
          errors["package.json"] = err.message;
        }

        removeDeletedViews(id, contents, function (removeErrors) {
          if (removeErrors) {
            // todo handle these
          }

          async.eachSeries(
            contents,
            function (name, next) {
              // Skip ignored files or Package.json or dotfiles
              if (name === PACKAGE || shouldIgnoreFile(name) || name.startsWith('.')) return next();

              fs.stat(dir + "/" + name, function (err, stat) {
                // Skip folders, or files which are too large
                if (err || !stat || stat.size > MAX_SIZE || stat.isDirectory())
                  return next();

                fs.readFile(dir + "/" + name, "utf-8", function (err, content) {
                  if (err) return next();

                  // We look up this view file to merge any existing properties
                  // Should this really be handled by setView? It looks like
                  // setView already calls getView...
                  getView(id, name, function (err, view) {
                    // getView returns an error if the view does not exist
                    // We want to be able to create new views using local editing
                    // we so ignore this error, and create the view object as needed
                    view = view || {};
                    view.name = view.name || name;

                    // Views might not exist if there's an error
                    // with the template's package.json file
                    if (views && views[name])
                      for (var i in views[name]) view[i] = views[name][i];

                    view.content = content;
                    if (
                      Array.isArray(view.urlPatterns) &&
                      view.urlPatterns.length
                    ) {
                      view.url = view.urlPatterns;
                    }
                    view.url = view.url || "/" + view.name;

                    setView(id, view, function (err) {
                      // we expose this error to the developer on
                      // the preview subdomain
                      if (err) {
                        errors[view.name] = improveMustacheErrorMessage(
                          err,
                          content
                        );
                      }

                      next();
                    });
                  });
                });
              });
            },
            function (err) {
              if (err) return callback(err);
              setMetadata(id, { errors }, function (err) {
                if (err) return callback(err);
                if (enabled === true) {
                  Blog.set(blogID, { template: id }, function (err) {
                    if (err) return callback(err);
                    getMetadata(id, function (err, template) {
                      callback(err, template);
                    });
                  });
                } else {
                  getMetadata(id, function (err, template) {
                    callback(err, template);
                  });
                }
              });
            }
          );
        });
      });
    }
  });
};

function loadPackage (id, dir, callback) {
  fs.readFile(dir + "/" + PACKAGE, "utf-8", function (err, contents) {
    // Package.json is optional
    if (err && err.code === "ENOENT") {
      return callback(null, {});
    }

    if (err) {
      return callback(new Error("Invalid package.json file: " + err.code));
    }

    try {
      const metadata = JSON.parse(contents);
      metadata.localEditing = true;
      savePackage(id, metadata, function (err, views) {
        callback(err, views, metadata.enabled);
      });
    } catch (err) {
      const error = new Error(improveJSONErrorMessage(err, contents));
      return callback(error);
    }
  });
}

function removeDeletedViews (templateID, contents, callback) {
  const viewsToRemove = [];

  // The rejection handler sits beside the success handler rather than in a
  // trailing .catch, so a throw further down the callback chain can't call
  // the callback a second time
  client
    .sMembers(key.allViews(templateID))
    .then(function (viewNames) {
      for (const viewName of viewNames) {
        let found = contents.find(fileName => fileName.startsWith(viewName));
        if (!found) viewsToRemove.push(viewName);
      }

      async.eachSeries(
        viewsToRemove,
        function (viewName, next) {
          dropView(templateID, viewName, next);
        },
        callback
      );
    }, callback);
}

function badPermission (blogID, templateID) {
  return new Error("No permission for " + blogID + " to write " + templateID);
}
