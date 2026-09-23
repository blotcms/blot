var setMetadata = require("./setMetadata");
var type = require("helper/type");
var validatePresets = require("./presets").validatePresets;
var toPackagePresets = require("./presets").toPackagePresets;

module.exports = {
  generate: function (blogID, metadata, views) {
    var Package = {};

    if (metadata.name) {
      Package.name = metadata.name;
    }

    if (metadata.locals) {
      Package.locals = metadata.locals;
    }

    var packagePresets = toPackagePresets(metadata.presets);
    if (packagePresets) {
      Package.presets = packagePresets;
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

    // package.json is the source of truth for presets. A document which omits
    // them clears any presets stored earlier. Invalid entries are dropped and
    // reported after the rest of the package has been saved.
    var localsForPresets =
      metadata.locals && type(metadata.locals, "object") ? metadata.locals : {};
    var checkedPresets = validatePresets(
      Object.prototype.hasOwnProperty.call(metadata, "presets") ? metadata.presets : null,
      localsForPresets
    );
    changes.presets = checkedPresets.presets;
    var presetError = null;
    if (checkedPresets.errors.length) {
      presetError = new Error(checkedPresets.errors.join("\n"));
      presetError.code = "EPRESETS";
      presetError.status = 400;
    }

    if (metadata.views && type(metadata.views, "object")) {
      views = metadata.views;
    }

    setMetadata(id, changes, function (err) {
      if (err) return callback(err);
      callback(presetError, views);
    });
  }
};

function objectWithProperties (obj) {
  return type(obj, "object") && Object.keys(obj).length;
}
