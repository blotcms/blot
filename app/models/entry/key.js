var pathNormalize = require("helper/pathNormalizer");

module.exports = {
  url: function (blogID, url) {
    return "blog:" + blogID + ":url:" + url;
  },

  entry: function (blogID, path) {
    return "blog:" + blogID + ":entry:" + pathNormalize(path);
  },

  // Set representing the paths of files which depend on this particular
  // path. The path itself may or may not be its own entry.
  // A path cannot have dependencies however without it also being an entry
  // so we just stories the dependencies for an entry under its property
  dependents: function (blogID, path) {
    return "blog:" + blogID + ":dependents:" + pathNormalize(path);
  },

  search: function (blogID) {
    return "blog:" + blogID + ":search";
  },
};
