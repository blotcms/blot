var { v4: uuid } = require("uuid");
var extname = require("path").extname;
var assets = require("storage/assets");
var folder = "_avatars";

var VALID_EXTENSIONS = [".jpg", ".jpeg", ".png", ".gif"];
var INVALID_EXTENSION =
  "Please choose an image of these formats: " + VALID_EXTENSIONS.join(", ");

module.exports = function (req, res, next) {
  if (!req.files || !req.files.avatar) return next();

  var avatar = Array.isArray(req.files.avatar)
    ? req.files.avatar[0]
    : req.files.avatar;

  if (!avatar || !avatar.size) {
    return next();
  }

  var extension = extname(avatar.path).toLowerCase();

  if (VALID_EXTENSIONS.indexOf(extension) === -1) {
    return next(new Error(INVALID_EXTENSION));
  }

  var name = uuid() + extension;
  var relPath = folder + "/" + name;
  var url = assets.url(req.blog.id, relPath);

  // The combined photo/favicon flow needs the temporary upload after the
  // avatar has been stored, so it opts into copying rather than moving it.
  var move = !req.preserveAvatarUpload;

  assets.writeFrom(req.blog.id, relPath, avatar.path, { move: move }).then(
    function () {
      req.updates.avatar = url;
      req.savedAvatarRelPath = relPath;
      next();
    },
    next
  );
};
