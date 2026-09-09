var resaveEntries = require("models/entries").resave;
var Blog = require("models/blog");
var _ = require("lodash");
var rebuild = require("sync/rebuild");

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

module.exports = function (req, res, next) {
  var updates = req.updates || {};
  // req.path is relative to the router mount, so fall back to the full
  // dashboard path (req.baseUrl + req.path) rather than "/", which would
  // bounce the user out to the site homepage.
  var redirect = req.body.redirect || (req.baseUrl || "") + req.path;

  Blog.set(req.blog.id, updates, function (errors, changes) {
    if (errors)
      for (var i in errors)
        if (errors[i] instanceof Error) return next(errors[i]);

    if (errors) return next(errors);

    // We now need to save every entry so that
    // changes to permalink format take effect.
    if (changes.indexOf("permalink") > -1) {
      resaveEntries(req.blog.id, function () {});
    }

    // We need to build all the blog's entries if the user
    // has changed any of the plugins or the image metadata
    // preference so the stored EXIF matches their setting.
    if (
      changes &&
      (changes.indexOf("plugins") > -1 || changes.indexOf("imageExif") > -1 || changes.indexOf("converters") > -1)
    ) {
      // we need to fetch the latest version of the blog to rebuild
      const options = {
        thumbnails: false, // do not re-generate thumbnails
        imageCache: false, // do not re-cache images in posts
      };
      rebuild(req.blog.id, options, function () {});
    }

    // Add success message if we're going to the settings page
    // and successful changes were made
    if (changes && changes.length && _.isEmpty(errors)) {

      return res.message(
        redirect,
        dictionary[changes[0]] || "Saved changes to your " + changes[0]
      );
    }

    return res.redirect(redirect);
  });
};
