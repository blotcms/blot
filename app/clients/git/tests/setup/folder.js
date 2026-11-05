// The blog folder as the git client's specs look at it: only through
// storage/folder, by blog ID, so they hold whichever backend the folder is on.
//
//   var folder = require("./setup/folder");
//   await folder.write(blogID, "/a.txt", "A");      // set-up
//   await folder.read(blogID, "/a.txt");            // Buffer
//   await folder.has(blogID, "/a");                 // a file or a directory
//   await folder.isDirectory(blogID, "/a");         // null if nothing is there
//   await folder.names(blogID, "/dir");             // sorted entry names
//   await folder.tree(blogID);                      // { "a/b.txt": Buffer }
//   await folder.directories(blogID);               // ["a", "a/b"]
//
// tree and directories leave out anything inside a .git directory.
var storage = require("storage/folder");

function insideGit(path) {
  return path.split("/").indexOf(".git") !== -1;
}

async function stat(blogID, path) {
  try {
    return await storage.stat(blogID, path);
  } catch (err) {
    if (err.code === "ENOENT" || err.code === "ENOTDIR") return null;
    throw err;
  }
}

exports.read = function (blogID, path) {
  return storage.read(blogID, path);
};

exports.write = function (blogID, path, contents) {
  return storage.write(blogID, path, contents);
};

exports.remove = function (blogID, path) {
  return storage.remove(blogID, path);
};

exports.has = async function (blogID, path) {
  return !!(await stat(blogID, path));
};

exports.isDirectory = async function (blogID, path) {
  var found = await stat(blogID, path);
  return found ? found.isDirectory : null;
};

exports.names = async function (blogID, path) {
  return (await storage.listNames(blogID, path)).map((entry) => entry.name).sort();
};

exports.tree = async function (blogID) {
  var result = {};

  for await (var file of storage.walk(blogID, "/")) {
    if (insideGit(file)) continue;
    result[file.slice(1)] = await storage.read(blogID, file);
  }

  return result;
};

exports.directories = async function (blogID) {
  var result = [];

  for await (var path of storage.walk(blogID, "/", { directories: true })) {
    if (insideGit(path)) continue;
    var found = await stat(blogID, path);
    if (found && found.isDirectory) result.push(path.slice(1).replace(/\/$/, ""));
  }

  return result.sort();
};
