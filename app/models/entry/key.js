var pathNormalize = require("helper/pathNormalizer");

module.exports = {
  url: function (blogID, url) {
    return "blog:" + blogID + ":url:" + url;
  },

  entry: function (blogID, path) {
    return "blog:" + blogID + ":entry:" + pathNormalize(path);
  },

  // String: the url a deleted entry had, kept for as long as the deleted
  // entry is, so that if its file comes back under another url the old one
  // stays a permanent redirect (set.js)
  deletedUrl: function (blogID, path) {
    return "blog:" + blogID + ":deleted-url:" + pathNormalize(path);
  },

  // Set representing the paths of files which depend on this particular
  // path. The path itself may or may not be its own entry.
  // A path cannot have dependencies however without it also being an entry
  // so we just stories the dependencies for an entry under its property
  //
  // The path is lowercased: an entry can depend on a file that doesn't exist
  // yet (folderAssets records missing links), and the file may later arrive
  // with different casing (/Photo.JPG authored, /photo.jpg synced).
  dependents: function (blogID, path) {
    return (
      "blog:" + blogID + ":dependents:" + pathNormalize(path).toLowerCase()
    );
  },

  search: function (blogID) {
    return "blog:" + blogID + ":search";
  },
};
