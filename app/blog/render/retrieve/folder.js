const Path = require("path");
const storage = require("storage/folder");
const alphanum = require("helper/alphanum");
const { getEntry } = require("../../lib/models");
const asRetriever = require("../../lib/asRetriever");
const BLOT_CDN_TOKEN = require("../replaceFolderLinks/cdnToken");
const {
  htmlExtRegex,
  fileExtRegex,
  encodeFolderPath,
  versionedFolderPath,
} = require("../replaceFolderLinks/shared");

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

// The href templates should use for an item. Links to files go straight to the
// versioned CDN URL (reusing the listing's stat); `path` would hit the
// app's origin folder route instead. Directories are pages, and dotfile
// segments, .html and extensionless files aren't served from the CDN, so
// those get the plain encoded path.
function itemURL(blogID, path, stat) {
  const cdnable =
    !stat.isDirectory &&
    !path.split("/").some((segment) => segment[0] === ".") &&
    !htmlExtRegex.test(path) &&
    fileExtRegex.test(path);

  if (!cdnable) return encodeFolderPath(path);

  return BLOT_CDN_TOKEN + "/folder/" + versionedFolderPath(blogID, path, stat);
}

async function folder(req, res) {
  let path = "/";
  let parent;

  if (req.query.path) {
    path = req.query.path;
  }

  // ?path=a&path=b is an array
  if (typeof path !== "string") return [];

  if (path !== "/") {
    parent = Path.dirname(path);
  }

  let listing;

  try {
    listing = await storage.listAll(req.blog.id, path);
  } catch (err) {
    // We should pass this error back to the template in future
    return [];
  }

  // Remove dotfiles and folders
  listing = listing.filter((item) => item.name[0] !== ".");

  // alphanum sorts strings, so sort the names and look the stats up by name
  const stats = new Map(listing.map((item) => [item.name, item]));
  let contents = alphanum(listing.map((item) => item.name));

  try {
    contents = await mapLimit(contents, CONCURRENCY, async (name) => {
      const fullPathToItem = Path.join(path, name);
      const stat = stats.get(name);
      const entry = await getEntry(req.blog.id, fullPathToItem);

      return {
        name: name,
        path: fullPathToItem,
        pathURI: encodeURIComponent(fullPathToItem),
        url: itemURL(req.blog.id, fullPathToItem, stat),
        isDirectory: stat.isDirectory,
        isFile: !stat.isDirectory,
        entry: entry,
        // fs.Stats rounds mtimeMs to a whole millisecond for its mtime
        updated: new Date(Math.round(stat.modified)),
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
}

module.exports = asRetriever(folder);
