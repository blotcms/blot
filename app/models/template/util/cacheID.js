var crypto = require("crypto");

// A template's views are cached per blog cacheID and template cacheID (see
// blog/render/full-view-cache), so every change to a template's views or
// metadata writes it a new cacheID, in the same Redis write as the change.
// It is an opaque token, not a timestamp: the cache only needs a value no
// earlier version of the template had, and a random one stays new even when
// a template is dropped and recreated under the same ID.
function create() {
  return Date.now().toString(36) + crypto.randomBytes(6).toString("hex");
}

// Bumping the owner blog's cacheID also flushes the blog's pages from the
// proxies (models/blog/set), which is only needed when the template is the
// one the blog has installed: nothing else renders a template the blog isn't
// using except its preview subdomains, which the template cacheID covers.
function bumpBlogIfInstalled(owner, templateID, callback) {
  if (!owner || owner === "SITE") return callback();

  // Required here to avoid a dependency loop
  var Blog = require("models/blog");

  Blog.get({ id: owner }, function (err, blog) {
    if (err) return callback(err);
    if (!blog || blog.template !== templateID) return callback();

    Blog.set(owner, { cacheID: Date.now() }, function (err) {
      callback(err);
    });
  });
}

module.exports = { create, bumpBlogIfInstalled };
