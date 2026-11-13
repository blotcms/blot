const fs = require("fs-extra");
const load = require("./load");
const { join } = require("path");

// With the view cache on, the partials under a views root never change, so
// read the directory tree and every partial once per root, not on every render.
const CACHED = {};

// recursively list all files matching ext in dir and its subdirectories
async function list(dir, ext, partials) {
  const items = await fs.readdir(dir, { withFileTypes: true });

  for (const item of items) {
    const path = join(dir, item.name);
    if (item.isDirectory()) await list(path, ext, partials);
    else if (item.isFile() && item.name.endsWith(ext)) {
      partials[item.name.slice(0, -ext.length)] = path;
    }
  }

  return partials;
}

async function loadAll(partials, ext, root, cache) {
  const loaded = {};
  for (const name in partials) {
    loaded[name] = await load(partials[name], ext, root, cache);
  }
  return loaded;
}

async function loadRoot(root, ext, cache) {
  let paths = {};
  try {
    paths = await list(root, ext, {});
  } catch (e) {}
  return loadAll(paths, ext, root, cache);
}

module.exports = async function loadPartials(root, options, ext, cache) {
  let partials;

  if (cache) {
    const key = root + "\0" + ext;
    CACHED[key] = CACHED[key] || loadRoot(root, ext, cache);
    partials = { ...(await CACHED[key]) };
  } else {
    partials = await loadRoot(root, ext, cache);
  }

  const extra = { ...options.partials, ...options.settings.partials };

  if (Object.keys(extra).length) {
    Object.assign(partials, await loadAll(extra, ext, root, cache));
  }

  return partials;
};
