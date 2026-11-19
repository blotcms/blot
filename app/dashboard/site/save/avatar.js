var { v4: uuid } = require("uuid");
var extname = require("path").extname;
var assets = require("storage/assets");
var Blog = require("models/blog");
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

  assets
    .writeFrom(req.blog.id, relPath, avatar.path, { move: move })
    .then(function () {
      req.updates.avatar = url;
      req.savedAvatarRelPath = relPath;
      next();
    }, next);
};

// The relPath of the avatar a blog.avatar URL names, "_avatars/<name>", or
// null when it names anything else (empty, another blog's, an outside URL).
function relPathOf(blogID, url) {
  if (!url || typeof url !== "string") return null;

  var pathname;

  try {
    pathname = decodeURIComponent(new URL(url).pathname);
  } catch (err) {
    return null;
  }

  var prefix = "/" + blogID + "/" + folder + "/";
  var name = pathname.slice(prefix.length);

  if (pathname.indexOf(prefix) !== 0 || !name || /[/\\]|^\.+$/.test(name))
    return null;

  return folder + "/" + name;
}

// Deletes the avatar a blog had before it was replaced (or cleared), once
// the blog has been saved with the new one. A failure is logged and never
// thrown: the old file is only left behind, and the script
// scripts/storage/replaced-avatars.js removes those.
async function removeReplaced(blogID, previousUrl, currentUrl) {
  try {
    var previous = relPathOf(blogID, previousUrl);

    if (!previous || previous === relPathOf(blogID, currentUrl)) return;

    await assets.remove(blogID, previous);
  } catch (err) {
    console.error(
      "[avatar] could not remove the replaced avatar of " + blogID + ":",
      err
    );
    return;
  }

  // Saving an avatar doesn't change the blog's cacheID, and the weekly sweep
  // skips a blog whose cacheID hasn't (storage/sweep), though it would purge
  // the removed file's copy in Perma-Cache
  try {
    await Blog.bumpCacheID(blogID);
  } catch (err) {
    console.error("[avatar] could not update the cacheID of " + blogID, err);
  }
}

module.exports.relPathOf = relPathOf;
module.exports.removeReplaced = removeReplaced;
module.exports.folder = folder;
