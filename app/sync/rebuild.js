const fs = require("fs-extra");
const ensure = require("helper/ensure");
const type = require("helper/type");
const Update = require("./update");
const async = require("async");
const { join, resolve, basename } = require("path");
const localPath = require("helper/localPath");
const messenger = require("./messenger");
const { blog_static_files_dir } = require("config");
const { promisify } = require("util");
const Transformer = require("helper/transformer");
const Blog = require("models/blog");
const build = require("build");

function walk(dir, done) {
  var results = [];
  fs.readdir(dir, function (err, list) {
    if (err) return done(err);
    var pending = list.length;
    if (!pending) return done(null, results);
    list.forEach(function (file) {
      file = resolve(dir, file);
      fs.stat(file, function (err, stat) {
        if (stat && stat.isDirectory()) {
          // A "+" folder is a rebuild target in its own right. Once it has
          // been emptied no file path surfaces it, but its stale aggregate
          // entry still needs the EMPTY cleanup, so record the directory too.
          if (basename(file).endsWith("+")) results.push(file);
          walk(file, function (err, res) {
            results = results.concat(res);
            if (!--pending) done(null, results);
          });
        } else {
          results.push(file);
          if (!--pending) done(null, results);
        }
      });
    });
  });
}

module.exports = function main(blogID, options, callback) {
  if (type(options, "function") && type(callback, "undefined")) {
    callback = options;
    options = {};
  }

  ensure(blogID, "string").and(options, "object").and(callback, "function");

  Blog.get({ id: blogID }, function (err, blog) {
    if (err || !blog) return callback(err || new Error("No blog"));

    const { log, status } = messenger(blog);
    const update = new Update(blog, log, status);

    let blogDirectory = localPath(blog.id, "/");

    if (blogDirectory.endsWith("/")) blogDirectory = blogDirectory.slice(0, -1);

    walk(blogDirectory, async function (err, paths) {
      if (err) return callback(err);

      try {
        if (options.thumbnails) {
          const directory = join(blog_static_files_dir, blog.id, "_thumbnails");
          await wipeCache({ blogID: blog.id, label: "thumbnails", directory });
        }

        if (options.imageCache) {
          const directory = join(
            blog_static_files_dir,
            blog.id,
            "_image_cache"
          );
          await wipeCache({ blogID: blog.id, label: "image-cache", directory });
        }
      } catch (e) {
        return callback(e);
      }

      // Files inside a + folder all rebuild the same aggregated entry.
      // Process each multi-folder once so a 50-file album is not built
      // 50 separate times during a full rebuild.
      const seenMultiFolders = new Set();
      const updatePaths = [];

      paths.forEach(function (absPath) {
        var path = absPath.slice(blogDirectory.length);
        var multiInfo = build.findMultiFolder(path);

        if (multiInfo) {
          if (seenMultiFolders.has(multiInfo.folderPath)) return;
          seenMultiFolders.add(multiInfo.folderPath);
          updatePaths.push(multiInfo.folderPath);
          return;
        }

        updatePaths.push(path);
      });

      async.eachSeries(
        updatePaths,
        function (path, next) {
          update(path, function () {
            // todo: don't swallow error here
            next();
          });
        },
        () => {
          // todo: don't swallow error here
          callback();
        }
      );
    });
  });
};

async function wipeCache({ blogID, label, directory }) {
  const store = new Transformer(blogID, label);
  const flush = promisify(store.flush);

  await flush();
  await fs.emptyDir(directory);
}
