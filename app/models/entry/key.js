var pathNormalize = require("helper/pathNormalizer");

module.exports = {
  url: function (blogID, url) {
    return "blog:" + blogID + ":url:" + url;
  },

  entry: function (blogID, path) {
    return "blog:" + blogID + ":entry:" + pathNormalize(path);
  },

  // Redis hash representation of an entry. Written alongside the legacy JSON
  // string key (see ./set.js) so individual fields can be fetched with HMGET
  // instead of loading and JSON.parsing the whole entry. The string key stays
  // authoritative until the backfill (scripts/entry/backfill-hashes.js) has
  // run everywhere and the strings are purged.
  entryHash: function (blogID, path) {
    return "blog:" + blogID + ":entry:hash:" + pathNormalize(path);
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
