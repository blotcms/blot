var fs = require("fs-extra");
var os = require("os");
var path = require("path");

// Assets are staged outside the output tree. This keeps their directories from
// influencing final path allocation before the entry itself is written. The
// in-flight promise is kept on the entry, so concurrent calls share one
// directory.
module.exports = async function assetDirectory(entry) {
  if (entry.asset_directory) return entry.asset_directory;

  if (entry.asset_directory_promise) return entry.asset_directory_promise;

  const state = require("../lifecycle").current();
  const parent = state ? state.stagingDirectory : os.tmpdir();

  entry.asset_directory_promise = (async function () {
    try {
      await fs.ensureDir(parent);
      const directory = await fs.mkdtemp(path.join(parent, "blot-import-"));

      entry.asset_directory = directory;
      if (state) state.assets.add(directory);

      return directory;
    } finally {
      delete entry.asset_directory_promise;
    }
  })();

  return entry.asset_directory_promise;
};
