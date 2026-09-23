var fs = require("fs-extra");
var { v4: uuid } = require("uuid");
var extname = require("path").extname;
var config = require("config");
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
  var finalPath =
    config.blog_static_files_dir +
    "/" +
    req.blog.id +
    "/" +
    folder +
    "/" +
    name;
  var url = config.cdn.origin + "/" + req.blog.id + "/" + folder + "/" + name;

  // The combined photo/favicon flow needs the temporary upload after the
  // avatar has been stored, so it opts into copying rather than moving it.
  var store = req.preserveAvatarUpload ? fs.copy : fs.move;
  store(avatar.path, finalPath, function (err) {
    if (err) return next(err);

    req.updates.avatar = url;
    req.savedAvatarPath = finalPath;
    next();
  });
};
