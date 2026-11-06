const withCallback = require("helper/withCallback");
const folder = require("storage/folder");
const { dirname, join, basename, normalize } = require("path");
const debug = require("debug")("blot:entry:build:plugins:wikilinks:byFilename");

module.exports = function byFilename(
  blogID,
  pathOfPost,
  href,
  isLink,
  callback
) {
  debug("Looking up by filename:", href, "from", pathOfPost);

  if (!href) {
    debug("No href provided");
    return callback(new Error("No filename provided"));
  }

  const stripped = href.split("|")[0].trim();
  const targetName = basename(stripped);

  if (!targetName) {
    debug("No filename extracted from href:", href);
    return callback(new Error("No filename"));
  }

  // A failed read is the same as no entry
  const getEntry = withCallback(require("models/entry").get);
  const startDir = normalizeDir(dirname(pathOfPost));
  const visited = new Set();
  const queue = [];

  function normalizeDir(dir) {
    if (!dir || dir === ".") return "/";
    let normalizedPath = normalize(dir).replace(/\\+/g, "/");

    if (!normalizedPath.startsWith("/")) normalizedPath = "/" + normalizedPath;

    return normalizedPath;
  }

  function enqueue(dir) {
    const normalized = normalizeDir(dir);
    if (!visited.has(normalized)) {
      visited.add(normalized);
      queue.push(normalized);
    }
  }

  enqueue(startDir);

  function searchNext() {
    if (!queue.length) return callback(new Error("No entry found by filename"));

    const current = queue.shift();
    const parent = dirname(current);

    if (parent && parent !== current) enqueue(parent);

    // A directory which can't be read has nothing to search
    folder
      .listNames(blogID, current)
      .catch(() => [])
      .then(function handleDir(entries) {
        debug("Searching in", current, "for", targetName, "found", entries);

        entries.forEach((dirent) => {
          if (dirent.isDirectory) enqueue(join(current, dirent.name));
        });

        folder.resolveCaseInsensitive(blogID, join(current, targetName)).then(
          async function (resolvedPath) {
            // We don't want to match directories, only files
            try {
              const stat = await folder.stat(blogID, resolvedPath);
              if (stat && stat.isDirectory) {
                return searchNext();
              }
            } catch (e) {}

            debug("Found match at", resolvedPath);

            return getEntry(blogID, resolvedPath, function (err, entry) {
              if (entry) {
                debug("Entry found for", resolvedPath, entry);
                return callback(null, entry);
              } else {
                debug("No entry for", resolvedPath);
                return callback(null, {
                  url: resolvedPath,
                  title: targetName,
                  path: resolvedPath,
                });
              }
            });
          },
          () => searchNext()
        );
      });
  }

  searchNext();
};
