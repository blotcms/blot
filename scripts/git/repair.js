var each = require("../each/blog");
var fs = require("fs-extra");
var localPath = require("helper/localPath");
var rootDir = require("helper/rootDir");
var Git = require("simple-git");
var tempDir = require("helper/tempDir")();
var GIT_DATA_DIRECTORY = rootDir + "/app/clients/git/data";
var { v4: uuid } = require("uuid");

each(
  function (user, blog, next) {
    if (blog.client !== "git") return next();

    var blogFolder = localPath(blog.id, "/");
    var pathToGitRepo = localPath(blog.id, ".git");
    var bareRepoDirectory = GIT_DATA_DIRECTORY + "/" + blog.handle + ".git";
    var tmpClonedFolder = tempDir + uuid();
    var tmpBlogFolder = tempDir + uuid();

    if (fs.existsSync(pathToGitRepo)) return next();

    console.log("Repairing", blog.id, blog.handle);

    if (!fs.existsSync(bareRepoDirectory))
      return next(new Error("No bare repo " + bareRepoDirectory));

    if (!fs.existsSync(blogFolder))
      return next(new Error("No blog folder " + blogFolder));

    Git().clone(bareRepoDirectory, tmpClonedFolder, function (err) {
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
  },
  function () {
    console.log("Done!");
    process.exit();
  }
);
