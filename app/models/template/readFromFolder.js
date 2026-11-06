var folder = require("storage/folder");
var basename = require("path").basename;
var getMetadata = require("./getMetadata");
var setMetadata = require("./setMetadata");
var getView = require("./getView");
var makeID = require("./util/makeID");
var setView = require("./setView");
var withCallback = require("helper/withCallback");
const shouldIgnoreFile = require("clients/util/shouldIgnoreFile");
var MAX_SIZE = 2.5 * 1000 * 1000; // 2.5mb
var PACKAGE = "package.json";
var savePackage = require("./package").save;
var client = require("models/client");
var key = require("./key");
var dropView = require("./dropView");
const Blog = require("models/blog");
const create = require("./create");
const improveJSONErrorMessage = require("./util/improveJSONErrorMessage");
const improveMustacheErrorMessage = require("./util/improveMustacheErrorMessage");

// dir is the template's directory in the blog's folder, e.g. "/Templates/blog"
module.exports = withCallback(async function readFromFolder(blogID, dir) {
  // check the directory exists
  var entries = await folder.listNames(blogID, dir);

  var contents = entries.map(function (entry) {
    return entry.name;
  });

  if (!contents.length) throw new Error("No files found in " + dir);

  var id = makeID(blogID, basename(dir));
  var template;

  try {
    template = await getMetadata(id);
  } catch (err) {
    // Only a missing template is created here. Any other error (e.g. Redis
    // unavailable) must reach the callback, or buildFromFolder stalls and
    // the sync never releases the folder lock.
    if (err.code !== "ENOENT") throw err;
  }

  if (!template) {
    await create(blogID, basename(dir), { slug: basename(dir) });
  }

  const errors = {};
  var pkg = await loadPackage(blogID, id, dir);
  var views = pkg.views;
  var enabled = pkg.enabled;

  if (pkg.error) {
    errors["package.json"] = pkg.error.message;
  }

  try {
    await removeDeletedViews(id, contents);
  } catch (removeErrors) {
    // todo handle these
  }

  for (var name of contents) {
    // Skip ignored files or Package.json or dotfiles
    if (name === PACKAGE || shouldIgnoreFile(name) || name.startsWith("."))
      continue;

    var stat;

    try {
      stat = await folder.stat(blogID, dir + "/" + name);
    } catch (err) {
      continue;
    }

    // Skip folders, or files which are too large
    if (!stat || stat.size > MAX_SIZE || stat.isDirectory) continue;

    var buffer;

    try {
      buffer = await folder.read(blogID, dir + "/" + name);
    } catch (err) {
      continue;
    }

    var content = buffer.toString("utf-8");
    var view;

    // We look up this view file to merge any existing properties
    // Should this really be handled by setView? It looks like
    // setView already calls getView...
    try {
      view = await getView(id, name);
    } catch (err) {
      // getView returns an error if the view does not exist
      // We want to be able to create new views using local editing
      // we so ignore this error, and create the view object as needed
      view = undefined;
    }

    view = view || {};
    view.name = view.name || name;

    // Views might not exist if there's an error
    // with the template's package.json file
    if (views && views[name])
      for (var i in views[name]) view[i] = views[name][i];

    view.content = content;
    if (Array.isArray(view.urlPatterns) && view.urlPatterns.length) {
      view.url = view.urlPatterns;
    }
    view.url = view.url || "/" + view.name;

    try {
      await setView(id, view);
    } catch (err) {
      // we expose this error to the developer on
      // the preview subdomain
      errors[view.name] = improveMustacheErrorMessage(err, content);
    }
  }

  // A template read from the blog's folder is edited there, with
  // or without a package.json: every sync rebuilds it from these
  // files, so dashboard saves must be written back to them
  // (dashboard/site/template/save/writeChangeToFolder.js)
  await setMetadata(id, { errors, localEditing: true });

  if (enabled === true) {
    await Blog.set(blogID, { template: id });
  }

  return getMetadata(id);
});

// Never rejects: resolves to { error, views, enabled }, where views and
// enabled are set whenever the package.json could be read, even if saving
// it failed
async function loadPackage(blogID, id, dir) {
  var buffer;

  try {
    buffer = await folder.read(blogID, dir + "/" + PACKAGE);
  } catch (err) {
    // Package.json is optional
    if (err.code === "ENOENT") return { views: {} };

    return { error: new Error("Invalid package.json file: " + err.code) };
  }

  var contents = buffer.toString("utf-8");

  try {
    const metadata = JSON.parse(contents);
    metadata.localEditing = true;

    return await new Promise(function (resolve) {
      savePackage(id, metadata, function (err, views) {
        resolve({ error: err, views: views, enabled: metadata.enabled });
      });
    });
  } catch (err) {
    return { error: new Error(improveJSONErrorMessage(err, contents)) };
  }
}

async function removeDeletedViews(templateID, contents) {
  const viewsToRemove = [];
  const viewNames = await client.sMembers(key.allViews(templateID));

  for (const viewName of viewNames) {
    let found = contents.find((fileName) => fileName.startsWith(viewName));
    if (!found) viewsToRemove.push(viewName);
  }

  for (const viewName of viewsToRemove) {
    await dropView(templateID, viewName);
  }
}
