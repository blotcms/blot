var { blog_static_files_dir } = require("config");
var ensure = require("helper/ensure");
var fs = require("fs-extra");
var { join, sep } = require("path");

// Every per-blog generated asset (thumbnails, image cache, converter output,
// avatars, template uploads, ...) lives under blog_static_files_dir/{blogID}.
// This module is the single choke point for building paths inside that
// directory, so a later commit() hook (for moving these assets
// to S3) only needs to be added here rather than at every call site.

function root(blogID) {
  ensure(blogID, "string");

  if (!blogID) throw new Error("storage/assets: blogID must be a non-empty string");

  return join(blog_static_files_dir, blogID);
}

// Builds an absolute path inside a blog's asset directory. With no segments
// this returns the directory itself. Throws if the joined path would resolve
// outside of it (e.g. a segment of "../").
function path(blogID, ...segments) {
  var base = root(blogID);

  if (!segments.length) return base;

  var full = join(base, ...segments);

  if (full !== base && full.indexOf(base + sep) !== 0) {
    throw new Error(
      "storage/assets: path escapes blog's asset directory: " +
        segments.join("/")
    );
  }

  return full;
}

// Removes a blog's entire asset directory. This is only used by blog
// deletion. Preserves the realpath safety check that used to live in
// app/models/blog/remove.js's safelyRemove: resolve both realpaths and make
// sure the folder is strictly inside blog_static_files_dir before removing.
async function removeAll(blogID) {
  var folder = root(blogID);
  var realpathToFolder;

  try {
    realpathToFolder = await fs.realpath(folder);
  } catch (err) {
    // This folder does not exist, so no need to do anything
    if (err.code === "ENOENT") return;
    throw err;
  }

  var realpathToRoot = await fs.realpath(blog_static_files_dir);

  if (realpathToFolder.indexOf(realpathToRoot + sep) !== 0) {
    throw new Error("Could not safely remove directory: " + folder);
  }

  await fs.remove(realpathToFolder);
}

module.exports = { path, removeAll };
