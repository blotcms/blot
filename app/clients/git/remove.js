var debug = require("debug")("blot:clients:git:remove");
var repo = require("./repo");

// This should probably copy the file to a
// temporary location so the removal can be
// rolled back if we encounter an error
async function remove(blogID, path) {
  debug("Blog:", blogID, "Removing", path);

  await repo.commit(blogID, { path: path, contents: null });
}

module.exports = remove;
