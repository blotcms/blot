var each = require("../each/blog");
var fs = require("fs-extra");
var storage = require("storage/folder");
var rootDir = require("helper/rootDir");
var Git = require("clients/git/git");
var repo = require("clients/git/repo");
var tempDir = require("helper/tempDir")();
var { v4: uuid } = require("uuid");

// This moves whole folders on disk, so it works on the real local paths of
// the local-disk backend of storage/folder.
async function repair(blog, next) {
  if (blog.client !== "git") return next();

  var blogFolder = await storage.path(blog.id, "/");
  var pathToGitRepo = await storage.path(blog.id, ".git");
  var bareRepoDirectory = repo.directory(blog.handle);
  var tmpClonedFolder = tempDir + uuid();
  var tmpBlogFolder = tempDir + uuid();

  if (fs.existsSync(pathToGitRepo)) return next();

  console.log("Repairing", blog.id, blog.handle);

  if (!fs.existsSync(bareRepoDirectory))
    return next(new Error("No bare repo " + bareRepoDirectory));

  if (!fs.existsSync(blogFolder))
    return next(new Error("No blog folder " + blogFolder));

  Git(rootDir).raw(["clone", bareRepoDirectory, tmpClonedFolder], function (err) {
    if (err) return next(err);

    console.log(blogFolder, ">", tmpBlogFolder);
    fs.moveSync(blogFolder, tmpBlogFolder);
    console.log(tmpClonedFolder, ">", blogFolder);
    fs.moveSync(tmpClonedFolder, blogFolder);

    fs.removeSync(tmpClonedFolder);
    console.log(tmpClonedFolder, "removed");

    console.log("Repaired", blog.id, blog.handle);
    next();
  });
}

each(
  function (user, blog, next) {
    repair(blog, next).catch(next);
  },
  function () {
    console.log("Done!");
    process.exit();
  }
);
