const folderRoot = require("../load/util/folder-root");
const { isAjaxRequest } = require("./ajax-response");

// Saves `folder_root` as a normalised path ("Posts/" becomes "/Posts") and
// refuses one with a ".." segment. A folder which doesn't exist is saved
// anyway: it may be created later, and the editor shows an error beside the
// control until it is. An empty string is kept, and means the default.
module.exports = function folderRootSave(req, res, next) {
  const body = req.body || {};
  const submitted =
    body["locals.folder_root"] ??
    (body.locals && typeof body.locals === "object"
      ? body.locals.folder_root
      : undefined);

  if (submitted === undefined) return next();

  const path =
    typeof submitted === "string" && submitted.trim() === ""
      ? ""
      : folderRoot.normalize(submitted);

  if (path === null) {
    const message = "A folder can't contain ..";

    if (isAjaxRequest(req)) {
      return res.status(400).set("Cache-Control", "no-store").json({
        error: message,
      });
    }

    return res.message(req.baseUrl + req.url, new Error(message));
  }

  req.locals.folder_root = path;

  next();
};
