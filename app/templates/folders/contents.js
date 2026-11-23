const crypto = require("crypto");
const fs = require("fs-extra");
const { join } = require("path");
const hashFile = require("helper/hashFile");

// The files of a demo folder, and one hash of them all. The download ZIP is
// stored under that hash (zipKey.js), and the docs build links the same
// hash, so the image build (which has the folders) and the deploy step
// (which uploads the ZIP) agree on the URL without talking to each other.

// Every file below directory, as sorted paths relative to it with forward
// slashes. Symlinks are skipped: the ZIP would follow them out of the folder.
async function listFiles(directory) {
  const files = [];

  async function walk(relative) {
    const entries = await fs.readdir(join(directory, relative), {
      withFileTypes: true,
    });

    for (const entry of entries) {
      const path = relative ? relative + "/" + entry.name : entry.name;
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) files.push(path);
    }
  }

  await walk("");

  return files.sort();
}

// A hash of the folder's file paths and contents: the same files give the
// same hash wherever they are. 16 hex characters, as in the ZIP's URL.
async function hashFolder(directory) {
  const hash = crypto.createHash("sha1");

  for (const path of await listFiles(directory)) {
    hash.update(path + "\0" + (await hashFile(join(directory, path))) + "\0");
  }

  return hash.digest("hex").slice(0, 16);
}

module.exports = { listFiles, hashFolder };
