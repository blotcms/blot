var joinpath = require("path").join;
var sep = require("path").sep;
var isOwner = require("./isOwner");
var getAllViews = require("./getAllViews");
var withCallback = require("helper/withCallback");
var folder = require("storage/folder"); // reads only
var blogFolder = require("clients/folder");
var generatePackage = require("./package").generate;
var determineTemplateFolder = require("./determineTemplateFolder");
var withFolderLock = require("./withFolderLock");
var PACKAGE = "package.json";
const shouldIgnoreFile = require("clients/util/shouldIgnoreFile");

async function writeToFolderUnlocked(blogID, templateID) {
  var owner = await isOwner(blogID, templateID);

  if (!owner) throw badPermission(blogID, templateID);

  var result = await getAllViews(templateID);
  var views = result.views;
  var metadata = result.metadata;

  if (!views || !metadata) throw noTemplate(blogID, templateID);

  var folderName = await determineTemplateFolder(blogID);
  var dir = joinpath(folderName, metadata.slug);
  var shouldCompareWrites = true;
  var existingFiles = await listLocalFiles(blogID, dir);

  await writeTemplateContents(blogID, dir, metadata, views, {
    compare: shouldCompareWrites,
    existingFiles: existingFiles,
  });
}

function writePackage(blogID, dir, metadata, views, compare) {
  var Package = generatePackage(blogID, metadata, views);
  return writeFile(blogID, joinpath(dir, PACKAGE), Package, compare);
}

function write(blogID, dir, view, compare) {
  var path = joinpath(dir, view.name);
  var content = view.content;

  return writeFile(blogID, path, content, compare);
}

async function writeFile(blogID, path, content, compare) {
  if (shouldIgnoreFile(path)) {
    // Silently skip ignored files to avoid breaking legacy templates
    // that may have ignored files in their stored views
    return;
  }

  if (compare) {
    var existing;
    var unreadable = false;

    try {
      existing = await folder.read(blogID, path);
    } catch (err) {
      unreadable = true;
    }

    if (!unreadable && existing.toString("utf-8") === content) return;
  }

  // The client's write also writes Blot's copy of the folder
  return blogFolder.write(blogID, path, content);
}

async function writeTemplateContents(blogID, dir, metadata, views, options) {
  options = options || {};

  var compare = options.compare !== false;
  var existingFiles = Array.isArray(options.existingFiles)
    ? options.existingFiles.map(normalizePath)
    : null;
  var written = existingFiles ? new Set([normalizePath(PACKAGE)]) : null;

  await writePackage(blogID, dir, metadata, views, compare);

  for (var name of Object.keys(views)) {
    var view = views[name];

    if (!view || !view.name || !view.content) continue;

    await write(blogID, dir, view, compare);

    if (written) written.add(normalizePath(view.name));
  }

  if (written) {
    await removeOrphanedFiles(blogID, dir, existingFiles, written);
  }
}

async function listLocalFiles(blogID, dir) {
  var entries;

  try {
    entries = await folder.listNames(blogID, dir);
  } catch (err) {
    if (err.code === "ENOENT" || err.code === "ENOTDIR") return [];
    throw err;
  }

  // Only the files directly inside the template's folder count. A view's
  // name can't hold a backslash, so a file with one is never an orphan.
  return entries
    .filter(function (entry) {
      return (
        !entry.isDirectory &&
        !/\\/.test(entry.name) &&
        !shouldIgnoreFile(entry.name)
      );
    })
    .map(function (entry) {
      return normalizePath(entry.name);
    });
}

async function removeOrphanedFiles(blogID, dir, existingFiles, written) {
  var toRemove = existingFiles.filter(function (file) {
    return !written.has(normalizePath(file));
  });

  for (var file of toRemove) {
    var relativePath = joinpath(dir, file);

    // The client's remove also removes Blot's copy
    try {
      await blogFolder.remove(blogID, relativePath);
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
  }
}

function normalizePath(path) {
  return typeof path === "string" ? path.split(sep).join("/") : path;
}

function badPermission(blogID, templateID) {
  return new Error("No permission for " + blogID + " to write " + templateID);
}

function noTemplate(blogID, templateID) {
  return new Error("No template for " + blogID + " and " + templateID);
}

module.exports = withCallback(withFolderLock(writeToFolderUnlocked));
