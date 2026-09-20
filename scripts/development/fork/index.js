// Local (development container) half of `npm run fork`.
//
//   node scripts/development/fork create <handle> < settings.json
//     Creates a blog on example@example.com with the given handle (or the
//     first free variant of it), applies the production settings JSON read
//     from stdin (see scripts/blog/export-settings) and prints blogID=... and
//     handle=... lines.
//
//   node scripts/development/fork finish <blogID> [templateSlug]
//     Rebuilds the blog from its folder, builds the folder's templates, and
//     if a template slug is passed, switches the blog to that template, then
//     starts the folder watcher and prints url=...

var User = require("models/user");
var Blog = require("models/blog");
var Template = require("models/template");
var validate = require("models/blog/validate/handle");
var rebuild = require("sync/rebuild");
var client = require("models/client");
var config = require("config");
var fs = require("fs-extra");

// app/clients/local/init.js listens here to start watching a new folder
var LOCAL_CLIENT_CHANNEL = "clients:local:new-folder";

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

function create(base, settings, callback) {
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

        // Production settings first, then the same overrides
        // app/configure-local-blogs.js gives local blogs
        var changes = Object.assign({}, settings, {
          forceSSL: false,
          client: "local",
        });

        Blog.set(blog.id, changes, function (err) {
          if (err) return callback(err);
          console.log("blogID=" + blog.id);
          console.log("handle=" + blog.handle);
          callback();
        });
      });
    });
  });
}

function finish(blogID, slug, callback) {
  rebuild(blogID, {}, function (err) {
    if (err) return callback(err);

    // rebuild skips /Templates, so build the folder's templates explicitly
    Template.buildFromFolder(blogID, function (err) {
      if (err) return callback(err);
      if (!slug) return watch(blogID, callback);
      activate(blogID, slug, function (err) {
        if (err) return callback(err);
        watch(blogID, callback);
      });
    });
  });
}

// Only after the folder is fully copied and built: the watcher ignores
// existing files, and starting it earlier races with the rsync and rebuild.
// It must start in the master process, which only hears about new folders
// through this channel (payload must be JSON).
function watch(blogID, callback) {
  client
    .publish(LOCAL_CLIENT_CHANNEL, JSON.stringify({ blogID: blogID }))
    .then(function () {
      Blog.get({ id: blogID }, function (err, blog) {
        if (err) return callback(err);
        console.log("url=https://" + blog.handle + "." + config.host);
        callback();
      });
    }, callback);
}

function activate(blogID, slug, callback) {
  var templateID = Template.makeID(blogID, slug);

  Template.getMetadata(templateID, function (err, template) {
    if (err || !template) {
      return callback(new Error("Template " + templateID + " was not built"));
    }

    Blog.set(blogID, { template: templateID }, callback);
  });
}

var command = process.argv[2];

if (command === "create" && process.argv[3]) {
  fs.readFile(0, "utf-8", function (err, input) {
    if (err) return done(err);
    var settings;
    try {
      settings = input.trim() ? JSON.parse(input) : {};
    } catch (e) {
      return done(new Error("Settings on stdin are not valid JSON"));
    }
    create(process.argv[3], settings, done);
  });
}
else if (command === "finish" && process.argv[3])
  finish(process.argv[3], process.argv[4], done);
else done(new Error("Usage: fork create <handle> | fork finish <blogID> [slug]"));
