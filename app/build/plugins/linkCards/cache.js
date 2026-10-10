const crypto = require("crypto");
const { join, dirname } = require("path");
const fs = require("fs-extra");
const config = require("config");

const { CACHE_DIRECTORY } = require("./constants");

function getCachePath(blogID, href) {
  if (!blogID) return null;
  try {
    const hash = crypto.createHash("sha1").update(href).digest("hex");
    return join(
      config.blog_static_files_dir,
      blogID,
      CACHE_DIRECTORY,
      `${hash}.json`
    );
  } catch (err) {
    return null;
  }
}

async function readCache(path) {
  if (!path) return null;
  try {
    return await fs.readJson(path);
  } catch (err) {
    return null;
  }
}

async function writeCache(path, metadata) {
  if (!path || !metadata) return;

  try {
    await fs.ensureDir(dirname(path));
  } catch (err) {
    return;
  }

  try {
    await fs.writeJson(path, metadata);
  } catch (err) {}
}

module.exports = {
  getCachePath,
  readCache,
  writeCache,
};
