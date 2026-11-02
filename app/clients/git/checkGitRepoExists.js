const Git = require("./git");
const debug = require("debug")("blot:clients:git:checkGitRepoExists");
const fs = require("fs-extra");
const storage = require("storage/folder");
const { basename } = require("path");

// Calls back with (null, directory) if the blog has a live clone, a
// repository in its blog folder's .git directory, where directory is the blog
// folder on local disk, or with an error if it has none. git works in a real
// directory, so a live clone needs the folder on disk: the live clones go
// before the blog folder leaves it.
module.exports = function (blogID, callback) {
  find(blogID).then(
    function (directory) {
      process.nextTick(callback, null, directory);
    },
    function (err) {
      process.nextTick(callback, err);
    }
  );
};

async function find(blogID) {
  // A clone has its .git directory at the top of the folder. Without one,
  // git would only find a repository above the folder, which is not a clone.
  if (!(await storage.exists(blogID, "/.git")))
    throw new Error("No .git directory in the blog folder of " + blogID);

  let blogDirectory = await storage.ensureLocal(blogID, "/");

  // The folder's own path ends in a slash
  if (blogDirectory.slice(-1) === "/") blogDirectory = blogDirectory.slice(0, -1);

  const git = Git(blogDirectory);

  // We want to compare the path to the blog folder with the path
  // to the repository that git is operating on. It is not
  // as simple as just checking `git rev-parse --is-inside-work-tree`
  // because all of the blogs git repos are inside the Blot codebase git
  // repo. This means that would ALWAYS be true even if there is no
  // repo in the user's blog's folder. So we use this git command which
  // tells us the top level of the current git repository:
  let pathToGitRepository = await git.raw(["rev-parse", "--show-toplevel"]);

  // Has a space at the start, in my testing at least
  pathToGitRepository = pathToGitRepository.trim();

  debug("Comparing path to git repository and blog folder:");

  if (
    !basename(pathToGitRepository).startsWith("blog_") ||
    basename(pathToGitRepository) !== basename(blogDirectory)
  ) {
    var message = [
      "Git repo does not exist in blog folder for " + blogDirectory,
      "- Path to git: " + pathToGitRepository,
      "- Blog folder: " +
        blogDirectory +
        " exists? " +
        fs.existsSync(blogDirectory),
      "Match? " + pathToGitRepository === blogDirectory
    ];

    throw new Error(message.join("\n"));
  }

  return blogDirectory;
}
