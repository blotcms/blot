// A sink for materialize() which writes to a local folder. See materialize.js
// for the interface. Blot's blog folder is one, and the specs use it.
//
// Nothing is followed through a symbolic link: one in the way of a directory
// or a file is replaced. A file is written to a temporary name next to its
// place and renamed over it once the whole body has arrived, so a body which
// fails its check at the end never appears under the real name, and a reader
// of the folder sees the old file or the new one.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { pipeline } = require("stream/promises");
const { safeParts } = require("./materialize");

async function lstat(file) {
  try {
    return await fs.promises.lstat(file);
  } catch (err) {
    if (err.code === "ENOENT" || err.code === "ENOTDIR") return null;
    throw err;
  }
}

async function remove(file) {
  await fs.promises.rm(file, { recursive: true, force: true });
}

function createFolderSink({ root }) {
  // Making directories is done one at a time. Two writes into a directory
  // which is not there yet, or has a link where it should be, would otherwise
  // each replace what the other had just made.
  let tail = Promise.resolve();

  function exclusive(task) {
    const result = tail.then(task);
    tail = result.catch(function () {});
    return result;
  }

  function partsOf(file) {
    const parts = safeParts(file);
    if (!parts) throw new Error("Not a safe path to write: " + JSON.stringify(file));
    return parts;
  }

  // The folder's directory for the first parts of a path, with each directory
  // made if it is missing. Something else in its place (a file, or a symbolic
  // link, which is not followed) is removed to make room.
  function ensureDirectory(parts) {
    return exclusive(async function () {
      let current = root;

      for (const part of parts) {
        current = path.join(current, part);

        const stat = await lstat(current);

        if (stat && stat.isDirectory()) continue;
        if (stat) await remove(current);

        await fs.promises.mkdir(current);
      }

      return current;
    });
  }

  async function write(file, stream, { mode }) {
    const parts = partsOf(file);
    const directory = await ensureDirectory(parts.slice(0, -1));
    const target = path.join(directory, parts[parts.length - 1]);
    const temporary = path.join(directory, ".write-" + crypto.randomBytes(8).toString("hex"));

    try {
      await pipeline(stream, fs.createWriteStream(temporary, { flags: "wx", mode }));

      // A directory has to go; a file or a link is replaced by the rename
      const stat = await lstat(target);
      if (stat && stat.isDirectory()) await remove(target);

      await fs.promises.rename(temporary, target);
    } catch (err) {
      await remove(temporary);
      throw err;
    }
  }

  // Removes a file, then the directories that this leaves empty. A directory in
  // its place, or a symbolic link on the way to it, is not something to remove.
  async function removeFile(file) {
    const parts = partsOf(file);
    let directory = root;

    for (const part of parts.slice(0, -1)) {
      directory = path.join(directory, part);

      const stat = await lstat(directory);

      if (!stat || !stat.isDirectory()) return;
    }

    const target = path.join(directory, parts[parts.length - 1]);
    const stat = await lstat(target);

    if (!stat || stat.isDirectory()) return;

    await fs.promises.unlink(target);

    for (let i = parts.length - 1; i > 0; i--) {
      try {
        await fs.promises.rmdir(path.join(root, ...parts.slice(0, i)));
      } catch (err) {
        // Not empty, so it and the directories above it stay
        if (err.code === "ENOTEMPTY" || err.code === "EEXIST" || err.code === "ENOENT") return;
        throw err;
      }
    }
  }

  async function symlink(file, target) {
    const parts = partsOf(file);
    const directory = await ensureDirectory(parts.slice(0, -1));
    const at = path.join(directory, parts[parts.length - 1]);

    if (await lstat(at)) await remove(at);

    await fs.promises.symlink(target, at);
  }

  return { write, remove: removeFile, symlink };
}

module.exports = createFolderSink;
