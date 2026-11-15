const folderRoot = require("./util/folder-root");

// Only the exact key `folder_root` is a folder picker. A key which merely
// contains "folder", such as `demo_folder` (the name of a documentation demo
// blog), is not a path in the blog's folder and keeps being a plain local.
const KEY = "folder_root";

module.exports = async function folderInput(req, res, next) {
  res.locals.folder_root_control = null;

  const locals = (req.template && req.template.locals) || {};

  if (!Object.prototype.hasOwnProperty.call(locals, KEY)) return next();

  // Empty or missing means the default folder
  const value = typeof locals[KEY] === "string" ? locals[KEY] : "";
  const control = {
    key: KEY,
    label: "Folder",
    value,
    placeholder: folderRoot.DEFAULT_FOLDER_ROOT,
    error: null,
  };

  try {
    const path = folderRoot.normalize(value || folderRoot.DEFAULT_FOLDER_ROOT);

    if (path === null) {
      control.error = "A folder can't contain ..";
    } else if ((await folderRoot.find(req.blog.id, path)) === null) {
      control.error = "This folder doesn't exist";
    }
  } catch (err) {
    // Whether the folder exists is a courtesy: if storage can't say, show
    // the control without an error rather than breaking the whole editor
    console.log("folder_root", req.blog && req.blog.id, err);
  }

  res.locals.folder_root_control = control;
  next();
};
