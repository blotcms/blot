var fs = require("fs-extra");
var repo = require("./repo");

// Rejects, moving nothing, if a repository is already at the new handle: it
// could be a stranded repository of another blog, so it is neither served to
// this blog nor replaced.
module.exports = async function renameRepo(formerHandle, latestHandle) {
  if (!formerHandle || !latestHandle || formerHandle === latestHandle) return;

  var formerPath = repo.directory(formerHandle);
  var latestPath = repo.directory(latestHandle);

  var formerExists = await fs.pathExists(formerPath);
  if (!formerExists) return;

  try {
    await fs.move(formerPath, latestPath);
  } catch (err) {
    throw new Error(
      "Failed to rename git repository from " +
        formerHandle +
        " to " +
        latestHandle +
        ": " +
        err.message
    );
  }
};
