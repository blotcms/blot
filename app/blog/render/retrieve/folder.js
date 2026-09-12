const fs = require("fs-extra");
const Path = require("path");
const localPath = require("helper/localPath");
const alphanum = require("helper/alphanum");
const { getEntry } = require("../../lib/models");
const asRetriever = require("../../lib/asRetriever");

const CONCURRENCY = 5;

async function mapLimit(items, limit, iterator) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await iterator(items[index], index);
    }
  }

  const workers = [];
  for (let i = 0; i < Math.min(limit, items.length); i++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return results;
}

async function folder(req, res) {
  let path = "/";
  let parent;

  if (req.query.path) {
    path = req.query.path;
  }

  if (path !== "/") {
    parent = Path.dirname(path);
  }

  let contents;

  try {
    contents = await fs.readdir(localPath(req.blog.id, path));
  } catch (err) {
    // We should pass this error back to the template in future
    return [];
  }

  // Remove dotfiles and folders
  contents = contents.filter((item) => item[0] !== ".");
  // `contents` is an array of raw filenames at this point, not objects,
  // so there's no `name` property to sort by - sort the strings directly.
  contents = alphanum(contents);

  try {
    contents = await mapLimit(contents, CONCURRENCY, async (name) => {
      const fullPathToItem = Path.join(path, name);
      const [stat, entry] = await Promise.all([
        fs.stat(localPath(req.blog.id, fullPathToItem)),
        getEntry(req.blog.id, fullPathToItem),
      ]);

      return {
        name: name,
        path: fullPathToItem,
        pathURI: encodeURIComponent(fullPathToItem),
        isDirectory: stat.isDirectory(),
        isFile: stat.isFile(),
        entry: entry,
        updated: stat.mtime,
      };
    });
  } catch (err) {
    return [];
  }

  return {
    contents,
    parent,
    parentURI: encodeURIComponent(parent),
  };
};

module.exports = asRetriever(folder);
