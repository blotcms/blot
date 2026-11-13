var resaveEntries = require("models/entries").resave;
var safeRedirect = require("dashboard/util/safe-redirect");
var Blog = require("models/blog");
var requestRebuild = require("./rebuild-settings");

var dictionary = {
  permalink: "Saved changes to your link format",
  forceSSL: "Saved SSL redirect setting",
  roundAvatar: "Saved photo settings",
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

  let changes;
  try {
    changes = await Blog.set(req.blog.id, updates);
  } catch (errors) {
    for (var i in errors)
      if (errors[i] instanceof Error) return next(errors[i]);
    return next(errors);
  }

  // We now need to save every entry so that
  // changes to permalink format take effect.
  if (changes.indexOf("permalink") > -1) {
    resaveEntries(req.blog.id).catch(function () {});
  }

  // We need to build all the blog's entries if the user
  // has changed any of the plugins or the image metadata
  // preference so the stored EXIF matches their setting.
  if (
    changes &&
    (changes.indexOf("plugins") > -1 ||
      changes.indexOf("imageExif") > -1 ||
      changes.indexOf("converters") > -1)
  ) {
    // One rebuild at a time per site; see rebuild-settings.js. The status
    // is stored before the response, so the next page shows the rebuild.
    try {
      await requestRebuild(req.blog.id);
    } catch (err) {
      console.log("Failed to start settings rebuild", req.blog.id, err.message);
    }
  }

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
