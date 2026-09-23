var setMetadata = require("./setMetadata");
var type = require("helper/type");

module.exports = {
  generate: function (blogID, metadata, views) {
    var Package = {};

    if (metadata.name) {
      Package.name = metadata.name;
    }

    if (metadata.locals) {
      Package.locals = metadata.locals;
    }

    if (metadata.enabled) {
      Package.enabled = metadata.enabled;
    }

    for (var name in views) {
      var view = views[name];
      var metadataToAddToPackage = {};

      var urlPatterns = null;

      if (type(view.urlPatterns, "array") && view.urlPatterns.length) {
        urlPatterns = view.urlPatterns;
      } else if (type(view.url, "array") && view.url.length) {
        urlPatterns = view.url;
      }

      if (urlPatterns && urlPatterns.length > 1) {
        metadataToAddToPackage.url = urlPatterns;
      } else if (view.url && view.url !== "/" + name) {
        metadataToAddToPackage.url = view.url;
      } else if (urlPatterns && urlPatterns.length === 1) {
        var singleUrl = urlPatterns[0];
        if (singleUrl !== "/" + name) {
          metadataToAddToPackage.url = singleUrl;
        }
      }

      if (view.locals && objectWithProperties(view.locals)) {
        metadataToAddToPackage.locals = view.locals;
      }

      if (view.partials && objectWithProperties(view.partials)) {
        // Don't output 'title': null in every view's partial
        for (let partial in view.partials)
          if (view.partials[partial] === null) delete view.partials[partial];

        if (Object.keys(view.partials).length)
          metadataToAddToPackage.partials = view.partials;
      }

      if (!objectWithProperties(metadataToAddToPackage)) continue;

      Package.views = Package.views || {};
      Package.views[name] = metadataToAddToPackage;
    }

    Package = JSON.stringify(Package, null, 2);

    return Package;
  },
  save: function (id, metadata, callback) {
    let views = {};
    let changes = {};

    if (!metadata) return callback(null, views);

    if (metadata.name) {
      changes.name = metadata.name;
    }

    if (metadata.localEditing) {
      changes.localEditing = metadata.localEditing;
    }

    if (metadata.locals && type(metadata.locals, "object")) {
      changes.locals = metadata.locals;
    }

    if (metadata.views && type(metadata.views, "object")) {
      views = metadata.views;
    }

    setMetadata(id, changes, function (err) {
      callback(err, views);
    });
  }
};

function objectWithProperties (obj) {
  return type(obj, "object") && Object.keys(obj).length;
}
