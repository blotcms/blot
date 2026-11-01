// Gives a test blog the live clone that blogs had before Blot's writes stopped
// being made in one (#2259 PR 8): a repository in the blog folder's .git
// directory, with the bare repository as its origin, at the bare repository's
// master. Resolves with the client's own wrapper (clients/git/git) for it.
//
// For the specs about blogs which still have one, until the clones are
// removed (PR 9).
var path = require("path");

module.exports = async function liveClone(ctx) {
  var Git = require("clients/git/git");
  var repo = require("clients/git/repo");
  var git = Git(ctx.blogDirectory, {
    env: { GIT_CEILING_DIRECTORIES: path.dirname(ctx.blogDirectory) },
  });

  await git.raw(["init", "--quiet", "--initial-branch=master"]);
  await git.raw(["remote", "add", "origin", repo.directory(ctx.blog.handle)]);
  await git.raw(["fetch", "--quiet", "origin"]);
  await git.raw(["reset", "--quiet", "--mixed", "origin/master"]);

  return git;
};
