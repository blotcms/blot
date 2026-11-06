const fs = require("fs-extra");
const load = require("./load");
const { join } = require("path");

const CACHED = {};

module.exports = async function loadPartials(root, options, ext, cache) {
  let partials = {};

  try {
    // recursively list all files matching ext in root and its subdirectories
    const list = async (dir) => {
      const items = cache
        ? CACHED[dir] || (await fs.readdir(dir))
        : await fs.readdir(dir);

      if (cache && !CACHED[dir]) CACHED[dir] = items;

      for (const item of items) {
        const path = join(dir, item);
        const stat = cache ? await fs.stat(path) : await fs.lstat(path);
        if (stat.isDirectory()) await list(path);
        else if (stat.isFile() && item.endsWith(ext)) {
          const nameWithoutExt = item.slice(0, -ext.length);
          partials[nameWithoutExt] = path;
        }
      }
    };
    await list(root);
  } catch (e) {}

  if (options.partials) {
    partials = { ...partials, ...options.partials };
  }

  if (options.settings.partials) {
    partials = { ...partials, ...options.settings.partials };
  }

  for (const name in partials) {
    const res = await load(partials[name], ext, root, cache);
    partials[name] = res;
  }

  return partials;
};
