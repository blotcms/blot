// Local (development container) half of `npm run fork`.
//
//   node scripts/development/fork create <handle>
//     Creates a blog on example@example.com with the given handle (or the
//     first free variant of it) and prints its blog ID on the last line.
//
//   node scripts/development/fork finish <blogID> [templateSlug]
//     Rebuilds the blog from its folder, and if a template slug is passed,
//     switches the blog to that template.

var User = require("models/user");
var Blog = require("models/blog");
var Template = require("models/template");
var validate = require("models/blog/validate/handle");
var rebuild = require("sync/rebuild");

var EMAIL = "example@example.com";

function done(err) {
  if (err) {
    console.error("Error:", err.message);
    process.exit(1);
  }
  process.exit();
}

function freeHandle(base, attempt, callback) {
  var candidate = attempt ? base + attempt : base;
  validate("", candidate, function (err, handle) {
    if (!err) return callback(null, handle);
    if (attempt >= 50) return callback(err);
    freeHandle(base, attempt + 1, callback);
  });
}

function create(base, callback) {
  User.getByEmail(EMAIL, function (err, user) {
    if (err || !user) {
      return callback(
        new Error(EMAIL + " not found — start the local server first (npm start)")
      );
    }

    freeHandle(base.toLowerCase().replace(/[^a-z0-9]/g, ""), 0, function (err, handle) {
      if (err) return callback(err);

      Blog.create(user.uid, { handle: handle }, function (err, blog) {
        if (err) return callback(err);

        // Same settings app/configure-local-blogs.js gives local blogs
        Blog.set(blog.id, { forceSSL: false, client: "local" }, function (err) {
          if (err) return callback(err);
          console.log(blog.id);
          callback();
        });
      });
    });
  });
}

function finish(blogID, slug, callback) {
  rebuild(blogID, {}, function (err) {
    if (err) return callback(err);
    if (!slug) return callback();

    var templateID = Template.makeID(blogID, slug);

    Template.getMetadata(templateID, function (err, template) {
      if (err || !template) {
        return callback(new Error("Template " + templateID + " was not built"));
      }

      Blog.set(blogID, { template: templateID }, callback);
    });
  });
}

var command = process.argv[2];

if (command === "create" && process.argv[3]) create(process.argv[3], done);
else if (command === "finish" && process.argv[3])
  finish(process.argv[3], process.argv[4], done);
else done(new Error("Usage: fork create <handle> | fork finish <blogID> [slug]"));
