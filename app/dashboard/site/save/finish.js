var safeRedirect = require("dashboard/util/safe-redirect");
var Blog = require("models/blog");
var pendingRebuilds = require("sync/pendingRebuilds");
var assets = require("storage/assets");
var avatar = require("./avatar");

var dictionary = {
  permalink: "Saved changes to your link format",
  forceSSL: "Saved SSL redirect setting",
  roundAvatar: "Saved photo settings",
  includeInDiscover: "Saved Discover setting",
  imageExif: "Saved image metadata preferences",
  converters: "Saved image publishing preferences",
  avatar: "Saved changes to your photo",
  menu: "Saved changes to your links",
  dateFormat: "Saved changes to the order in which you write your dates",
};

// N.B. In production this POST runs on green while the page you are redirected
// to renders on blue (proxy/config/http.conf, $dashboard_upstream).
// Don't rely on in-process cache invalidation here; see dashboard/site/index.js.
// Anything thrown below reaches Express as next(err)
module.exports = (req, res, next) => saveAndFinish(req, res, next).catch(next);

async function saveAndFinish(req, res, next) {
  var updates = req.updates || {};
  // req.path is relative to the router mount, so fall back to the full
  // dashboard path (req.baseUrl + req.path) rather than "/", which would
  // bounce the user out to the site homepage.
  var redirect = safeRedirect(
    req.body.redirect,
    (req.baseUrl || "") + req.path,
    req.hostname
  );

  var previousAvatar = req.blog.avatar;

  let changes;
  try {
    changes = await Blog.set(req.blog.id, updates);
  } catch (errors) {
    // The new file is unused if the blog still has its previous avatar. A
    // rejected save may still have stored the new one (Blog.set can reject
    // after its write, e.g. when flushing caches fails), so check, and keep
    // the file if the check itself fails
    if (req.savedAvatarRelPath) {
      try {
        const saved = await Blog.get({ id: req.blog.id });

        if (saved && saved.avatar !== updates.avatar)
          await assets.remove(req.blog.id, req.savedAvatarRelPath);
      } catch (err) {
        // Left behind; scripts/storage/replaced-avatars.js removes those
      }
    }

    for (var i in errors)
      if (errors[i] instanceof Error) return next(errors[i]);
    return next(errors);
  }

  if (changes && changes.indexOf("avatar") > -1)
    await avatar.removeReplaced(req.blog.id, previousAvatar, updates.avatar);

  // We now need to save every entry so that changes to permalink format
  // take effect, and build all the blog's entries if the user has changed
  // any of the plugins or the image metadata preference so the stored EXIF
  // matches their setting. Thumbnails and cached images are kept. The work
  // is queued in Redis first, so it finishes even if a deploy kills the
  // process running it (sync/pendingRebuilds); the page doesn't wait for it.
  var flags = [];

  if (changes.indexOf("permalink") > -1) flags.push("resave");

  if (
    changes.indexOf("plugins") > -1 ||
    changes.indexOf("imageExif") > -1 ||
    changes.indexOf("converters") > -1
  )
    flags.push("rebuild");

  if (flags.length) await pendingRebuilds.request(req.blog.id, flags);

  // Add success message if we're going to the settings page
  // and successful changes were made
  if (changes && changes.length) {
    return res.message(
      redirect,
      dictionary[changes[0]] || "Saved changes to your " + changes[0]
    );
  }

  return res.redirect(redirect);
}
