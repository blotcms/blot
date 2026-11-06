// Helpers for specs which set up or inspect a blog's folder. The folder lives
// in the storage bucket (MinIO in specs) and is reached only through
// storage/folder, so a spec can't write it with fs: these do the common
// things in a line. Available as global.test.folder.
const fs = require("fs-extra");
const { join, posix } = require("path");
const folder = require("storage/folder");

// Writes files into a blog's folder: files is { "/path": contents }, where
// contents is a string or a Buffer
async function writeFiles(blogID, files) {
  for (const path of Object.keys(files)) {
    await folder.write(blogID, path, files[path]);
  }
}

// Copies a directory on this machine (a fixture, a temporary directory) into
// a blog's folder at dest ("/" by default), file by file, keeping each file's
// modified time. Empty directories are made too. Resolves to the blog paths
// of the files copied, sorted.
async function copyDirectory(blogID, source, dest) {
  dest = dest || "/";

  const copied = [];

  async function visit(local, path) {
    const entries = (await fs.readdir(local, { withFileTypes: true })).sort(
      (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    );

    if (!entries.length && path !== "/") await folder.mkdir(blogID, path);

    for (const entry of entries) {
      const from = join(local, entry.name);
      const to = posix.join(path, entry.name);

      if (entry.isDirectory()) {
        await visit(from, to);
      } else if (entry.isFile()) {
        const { mtimeMs } = await fs.stat(from);
        await folder.writeFrom(blogID, to, from, { modified: mtimeMs });
        copied.push(to);
      }
    }
  }

  await visit(source, posix.join("/", dest));

  return copied.sort();
}

// The blog's folder as { "/path": contents as a string } for every file, or
// with { directories: true } also "/dir": null for every directory
async function tree(blogID, options) {
  const directories = !!(options && options.directories);
  const found = {};

  for await (const path of folder.walk(blogID, "/", { directories })) {
    const stat = await folder.stat(blogID, path);
    found[path] = stat.isDirectory
      ? null
      : (await folder.read(blogID, path)).toString();
  }

  return found;
}

// The paths of every file in the blog's folder, sorted
async function paths(blogID) {
  const found = [];
  for await (const path of folder.walk(blogID, "/")) found.push(path);
  return found.sort();
}

// A file's contents as a string
async function readText(blogID, path) {
  return (await folder.read(blogID, path)).toString();
}

module.exports = { writeFiles, copyDirectory, tree, paths, readText };
