var folder = require("storage/folder");
var FileFlags = require("models/file/flags");

// The sources a build reports flags from (models/file/flags.js)
var SOURCES = ["build", "assets", "references"];

// Stores what a build found on the file it built: each of the build's
// sources is replaced by that source's flags in found, so an empty list
// clears them. One source at a time, since each write reads the file's whole
// record and writes it back. A failure is ignored: flags only describe the
// file, and must not fail the sync.
module.exports = async function storeBuildFlags(blogID, path, found) {
  for (var source of SOURCES) {
    var list = (found || []).filter(function (flag) {
      return FileFlags.sourceOf(flag.code) === source;
    });

    try {
      await folder.setFlags(blogID, path, source, list);
    } catch (err) {}
  }
};
