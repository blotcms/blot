const folder = require("storage/folder");
const { dirname, join, basename, normalize } = require("path");
const debug = require("debug")("blot:entry:build:plugins:wikilinks:byFilename");

module.exports = async function byFilename(blogID, pathOfPost, href, isLink) {
  debug("Looking up by filename:", href, "from", pathOfPost);

  if (!href) {
    debug("No href provided");
    throw new Error("No filename provided");
  }

  const stripped = href.split("|")[0].trim();
  const targetName = basename(stripped);

  if (!targetName) {
    debug("No filename extracted from href:", href);
    throw new Error("No filename");
  }

  const getEntry = require("models/entry").get;
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

  while (queue.length) {
    const current = queue.shift();
    const parent = dirname(current);

    if (parent && parent !== current) enqueue(parent);

    // A directory which can't be read has nothing to search
    const entries = await folder.listNames(blogID, current).catch(() => []);

    debug("Searching in", current, "for", targetName, "found", entries);

    entries.forEach((dirent) => {
      if (dirent.isDirectory) enqueue(join(current, dirent.name));
    });

    let resolvedPath;

    try {
      resolvedPath = await folder.resolveCaseInsensitive(
        blogID,
        join(current, targetName)
      );
    } catch (err) {
      continue;
    }

    // We don't want to match directories, only files
    try {
      const stat = await folder.stat(blogID, resolvedPath);
      if (stat && stat.isDirectory) continue;
    } catch (e) {}

    debug("Found match at", resolvedPath);

    const entry = await new Promise((resolve) =>
      getEntry(blogID, resolvedPath, resolve)
    );

    if (entry) {
      debug("Entry found for", resolvedPath, entry);
      return entry;
    }

    debug("No entry for", resolvedPath);
    return {
      url: resolvedPath,
      title: targetName,
      path: resolvedPath,
    };
  }

  throw new Error("No entry found by filename");
};
