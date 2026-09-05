var async = require("async");
var fs = require("fs-extra");
var { join, dirname, basename, sep } = require("path");
var config = require("config");
var client = require("models/client");
var ensure = require("helper/ensure");
var urlNormalizer = require("helper/urlNormalizer");
var Entry = require("models/entry");
var Template = require("models/template");
var isRegex = require("./util").isRegex;

// Blot only checks a site's redirects once it has failed to find anything
// else to serve for a URL (see app/blog/index.js for the order of routes).
// A redirect whose 'from' is already served by a post, a page, a template
// view, a file in the folder, or one of Blot's own routes therefore never
// runs. That surprises people, so we look for those cases and explain them.

// Paths assets.js refuses to serve, meaning a redirect for them still runs
var UNSERVED_PATTERNS = ["..", ".php", "/.git", "\0"];

// Stops a site with an enormous number of redirects hammering the disk
var MAX_PATHS_CHECKED_ON_DISK = 500;

module.exports = function conflicts(blog, redirects, callback) {
  ensure(blog, "object").and(redirects, "array").and(callback, "function");

  var paths = redirects.map(function (redirect) {
    return comparablePath(redirect && redirect.from);
  });

  var results = paths.map(function () {
    return null;
  });

  checkBlotRoutes(paths, results);

  async.series(
    [
      function (next) {
        checkEntries(blog.id, paths, results, next);
      },
      function (next) {
        checkTemplateViews(blog.template, paths, results, next);
      },
      function (next) {
        checkFolder(blog.id, paths, results, next);
      },
    ],
    function (err) {
      if (err) return callback(err);
      callback(null, results);
    }
  );
};

// Returns the path a request would need to use for this redirect to match,
// or null when we can't say anything useful about it. Redirects.check tests
// the 'from' against req.url, so anything which isn't a plain path on this
// site is either a pattern we don't try to resolve or never matched at all.
function comparablePath(from) {
  if (typeof from !== "string" || !from.trim()) return null;

  from = from.trim();

  if (isRegex(from)) return null;
  if (from.indexOf("://") > -1) return null;

  return urlNormalizer(from) || null;
}

function pending(paths, results) {
  var indexes = [];

  paths.forEach(function (path, index) {
    if (path && !results[index]) indexes.push(index);
  });

  return indexes;
}

function checkBlotRoutes(paths, results) {
  pending(paths, results).forEach(function (index) {
    var purpose = blotRoute(paths[index]);

    if (!purpose) return;

    results[index] = {
      type: "route",
      path: paths[index],
      message:
        "This redirect will not be used because Blot uses " +
        paths[index] +
        " for " +
        purpose +
        ".",
    };
  });
}

// Routes which Blot always handles itself, from app/blog/index.js. Routes
// which fall through when they have nothing to serve, such as /robots.txt
// and the draft previews, are deliberately absent: a redirect for one of
// those URLs does run.
function blotRoute(path) {
  if (path === "/") return "the list of posts on your site";
  if (path === "/search") return "the search page on your site";
  if (path === "/random") return "a link to a random post on your site";
  if (path === "/layout.css" || path === "/html2canvas.min.js")
    return "a file it serves on every site";
  if (path === "/verify/domain-setup") return "checking your domain's setup";
  if (path === "/verify/subscription-duration")
    return "checking your subscription";
  if (/^\/page\/[^/]+$/.test(path)) return "the list of posts on your site";
  if (/^\/tagged\/[^/]+(\/page\/[^/]+)?$/.test(path))
    return "the list of posts with a given tag";

  return null;
}

function checkEntries(blogID, paths, results, callback) {
  var indexes = pending(paths, results);

  if (!indexes.length) return callback();

  // One round trip tells us which paths are worth loading in full. Most
  // redirects don't point at an existing post, so this usually ends here.
  var keys = indexes.map(function (index) {
    return Entry.key.url(blogID, decodeURISafely(paths[index]));
  });

  client
    .mGet(keys)
    .then(function (entryIDs) {
      var candidates = indexes.filter(function (index, position) {
        return !!entryIDs[position];
      });

      async.eachLimit(candidates, 10, checkEntry, callback);
    })
    .catch(callback);

  function checkEntry(index, next) {
    Entry.getByUrl(blogID, paths[index], function (entry) {
      // Blot skips these too, so the redirect still runs
      if (!entry || entry.deleted || entry.draft || entry.scheduled)
        return next();

      results[index] = {
        type: entry.page ? "page" : "post",
        path: paths[index],
        message:
          "This redirect will not be used because " +
          (entry.page ? "a page" : "a post") +
          " on your site is already published at " +
          paths[index] +
          ".",
      };

      next();
    });
  }
}

function checkTemplateViews(templateID, paths, results, callback) {
  var indexes = pending(paths, results);

  if (!templateID || !indexes.length) return callback();

  var urls = indexes.map(function (index) {
    return decodeURIComponentSafely(paths[index]);
  });

  Template.getViewsByURLs(templateID, urls, function (err, viewNames) {
    if (err) return callback(err);

    indexes.forEach(function (index, position) {
      if (!viewNames[position]) return;

      results[index] = {
        type: "view",
        path: paths[index],
        message:
          "This redirect will not be used because your template renders " +
          paths[index] +
          " using the view " +
          viewNames[position] +
          ".",
      };
    });

    callback();
  });
}

function checkFolder(blogID, paths, results, callback) {
  var indexes = pending(paths, results).filter(function (index) {
    return isServed(paths[index]);
  });

  if (!indexes.length || indexes.length > MAX_PATHS_CHECKED_ON_DISK)
    return callback();

  var folder = join(config.blog_folder_dir, blogID);

  async.eachLimit(indexes, 10, checkPath, callback);

  function checkPath(index, next) {
    var candidates = filesWhichWouldBeServed(folder, paths[index]);

    async.detectSeries(candidates, isFile, function (err, file) {
      if (err) return next(err);

      if (file)
        results[index] = {
          type: "file",
          path: paths[index],
          message:
            "This redirect will not be used because a file in your folder is already published at " +
            paths[index] +
            ".",
        };

      next();
    });
  }
}

function isServed(path) {
  return !UNSERVED_PATTERNS.some(function (pattern) {
    return path.indexOf(pattern) > -1;
  });
}

// The files assets.js will try, in order, for a given request. We skip its
// case-insensitive walk of the folder, which is expensive, so a file whose
// name is capitalized differently to the redirect goes unnoticed.
function filesWhichWouldBeServed(folder, url) {
  var path = decodeURIComponentSafely(url);

  return [
    path,
    path + "/index.html",
    path + "/_index.html",
    path + ".html",
    join(dirname(path), "_" + basename(path) + ".html"),
  ]
    .map(function (candidate) {
      return join(folder, candidate);
    })
    .filter(function (candidate) {
      // Don't let a path escape the site's folder
      return candidate.startsWith(folder + sep);
    });
}

function isFile(file, callback) {
  fs.stat(file, function (err, stat) {
    if (err) return callback(null, false);
    callback(null, stat.isFile());
  });
}

// Entry.getByUrl and app/blog/view.js decode the URL differently, so we
// match whichever the lookup we're about to make uses.
function decodeURISafely(url) {
  try {
    return decodeURI(url);
  } catch (e) {
    return url;
  }
}

function decodeURIComponentSafely(url) {
  try {
    return decodeURIComponent(url);
  } catch (e) {
    return url;
  }
}
