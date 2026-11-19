// The Local client's provider: a directory on the developer's machine,
// outside the blog's folder (#2258 Phase E). Development only: this module is
// only reached through clients/local, which clients/index.js registers only
// when config.environment === "development".
//
// The directory is data/local-sources/{handle}, or under
// BLOT_LOCAL_SOURCE_DIRECTORY when that is set. It is a path on this machine,
// not a blog folder, so plain fs is fine for it.

const { join, resolve, posix } = require("path");
const config = require("config");

function base() {
  return process.env.BLOT_LOCAL_SOURCE_DIRECTORY
    ? resolve(process.env.BLOT_LOCAL_SOURCE_DIRECTORY)
    : join(config.data_directory, "local-sources");
}

// The directory for a blog, from its handle (or its ID, for a blog with none)
async function directory(blogID) {
  const blog = await require("models/blog").get({ id: blogID });
  if (!blog) throw new Error("No blog with ID " + blogID);

  // A blog named like a demo folder is synced from that folder in the
  // checkout, so edits there reach it (see templates/folders/local.js)
  const demo = require("templates/folders/local").sourceFor(blog.handle);
  if (demo) return demo;

  const name = String(blog.handle || blog.id);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name) || name.indexOf("..") !== -1) {
    throw new Error("Unsuitable name for a source directory: " + name);
  }

  return join(base(), name);
}

// The absolute path in dir of a blog path such as "/posts/a.md", never
// outside dir
function absolute(dir, path) {
  return join(dir, posix.normalize("/" + path));
}

module.exports = { directory, absolute, base };
