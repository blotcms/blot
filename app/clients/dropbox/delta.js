const debug = require("debug")("blot:clients:dropbox:delta");
const retry = require("./util/retry");
const waitForErrorTimeout = require("./util/waitForErrorTimeout");
const isDotfileOrDotfolder = require("./util/constants").isDotfileOrDotfolder;
const localPath = require("helper/localPath");
const caseSensitivePath = require("util").promisify(
  require("helper/caseSensitivePath")
);
const fs = require("fs-extra");
const Path = require("path");
const clfdate = require("helper/clfdate");

const prefix = () => clfdate() + ' Dropbox: Delta: ';

function normalizeRelativePath(path) {
  return (path || "").replace(/^\/+/, "");
}

async function listDescendantPaths(rootPath) {
  const results = [];

  async function walk(currentPath) {
    let entries;

    try {
      entries = await fs.readdir(currentPath, { withFileTypes: true });
    } catch (err) {
      return;
    }

    for (const entry of entries) {
      const fullPath = Path.join(currentPath, entry.name);
      results.push(fullPath);

      if (entry.isDirectory()) {
        await walk(fullPath);
      }
    }
  }

  await walk(rootPath);
  return results;
}

function listDropboxFolderEntries(client, path) {
  return client
    .filesListFolder({
      path: path,
      include_deleted: false,
      recursive: false,
    })
    .then(function (response) {
      var entries = response.result.entries || [];
      var cursor = response.result.cursor;
      var hasMore = response.result.has_more;

      function next() {
        if (!hasMore) return Promise.resolve(entries);
        return client
          .filesListFolderContinue({ cursor: cursor })
          .then(function (nextResponse) {
            entries = entries.concat(nextResponse.result.entries || []);
            cursor = nextResponse.result.cursor;
            hasMore = nextResponse.result.has_more;
            return next();
          });
      }

      return next();
    });
}

async function injectCaseOnlyDeletes(entries, blogID, client) {

  console.log(prefix(), "Checking for case-only renames in", entries.length, "entries" );

  const normalizeRelativePathForComparison = function (relativePath) {
    return (relativePath || "").replace(/^\/+/, "").toLowerCase();
  };

  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];

    if (!entry || (entry[".tag"] !== "file" && entry[".tag"] !== "folder")) {
      continue;
    }

    if (!entry.relative_path || !entry.path_display) {
      continue;
    }

    let absolutePath;

    try {
      absolutePath = localPath(blogID, entry.relative_path);
    } catch (err) {
      continue;
    }

    const parentDir = Path.dirname(absolutePath);
    const targetName = Path.basename(absolutePath);
    const targetLower = targetName.toLowerCase();

    let localEntries;

    try {
      localEntries = await fs.readdir(parentDir);
    } catch (err) {
      // Sometimes the case returned in path_display / relative_path
      // is inconsistent with the true path on Dropbox. So we
      // use case-sensitive path to find the parent directory.
      if (err.code === "ENOENT") {
        try {
          console.log("Parent directory does not exist, trying case-sensitive path");
          const resolvedPath = await caseSensitivePath(localPath(blogID, '/'), Path.dirname(entry.relative_path));
          localEntries = await fs.readdir(resolvedPath);
        } catch (err2) {
          console.log(prefix(), "Error reading local directory with case-sensitive path:", err2);
          continue;
        }
      } else {
        console.log(prefix(), "Error reading local directory:", err);
        continue;
      }
    }

    const existingName = localEntries.find(function (name) {
      return name.toLowerCase() === targetLower && name !== targetName;
    });

    if (!existingName) {
      console.log(prefix(), "No case-only rename detected for entry");
      continue;
    }

    let dropboxParent = Path.posix.dirname(entry.path_display);
    if (dropboxParent === "/" || dropboxParent === ".") {
      dropboxParent = "";
    }

    let dropboxEntries;

    try {
      dropboxEntries = await listDropboxFolderEntries(client, dropboxParent);
    } catch (err) {
      debug("Error listing Dropbox folder for case-only rename", err);
      continue;
    }

    const newName = entry.name || Path.posix.basename(entry.path_display);
    const newEntry = dropboxEntries.find(function (item) {
      return item.name === newName;
    });
    const oldEntry = dropboxEntries.find(function (item) {
      return item.name === existingName;
    });

    if (!newEntry || oldEntry) {
      console.log(prefix(), "Could not find new or old entry in Dropbox folder");
      continue;
    }

    if (newEntry[".tag"] !== entry[".tag"]) {
      console.log(prefix(), "New entry type does not match original entry type");
      continue;
    }

    const relativeParent = Path.posix.dirname(entry.relative_path);
    let oldRelativePath;

    if (relativeParent === ".") {
      oldRelativePath = existingName;
    } else if (relativeParent === "/") {
      oldRelativePath = "/" + existingName;
    } else {
      oldRelativePath = Path.posix.join(relativeParent, existingName);
    }

    const deleteExists = function (relativePath) {
      const normalized = normalizeRelativePathForComparison(relativePath);
      return entries.some(function (item) {
        return (
          item &&
          item[".tag"] === "deleted" &&
          item.relative_path &&
          normalizeRelativePathForComparison(item.relative_path) === normalized
        );
      });
    };

    if (deleteExists(oldRelativePath)) {
      console.log(prefix(), "Delete entry for case-only rename already exists");
      continue;
    }

    const oldPathDisplay = dropboxParent
      ? Path.posix.join(dropboxParent, existingName)
      : "/" + existingName;

    console.log(prefix(), 
      "Injecting case-only delete for",
      oldRelativePath,
      "alongside",
      entry.relative_path
    );
    entries.splice(index, 0, {
      ".tag": "deleted",
      path_display: oldPathDisplay,
      relative_path: oldRelativePath,
    });

    if (entry[".tag"] === "folder") {
      const shouldPrefixSlash = entry.relative_path[0] === "/";
      let oldFolderPath;
      let blogRootPath;

      try {
        oldFolderPath = localPath(blogID, oldRelativePath);
        blogRootPath = localPath(blogID, "/");
      } catch (err) {
        index++;
        continue;
      }

      const descendantPaths = await listDescendantPaths(oldFolderPath);
      const descendantDeletes = [];

      for (const descendantPath of descendantPaths) {
        const relativeDiskPath = Path.relative(blogRootPath, descendantPath);

        if (!relativeDiskPath || relativeDiskPath.startsWith("..")) {
          continue;
        }

        const relativePathNoLeadingSlash = relativeDiskPath
          .split(Path.sep)
          .join(Path.posix.sep);

        const relativePath = shouldPrefixSlash
          ? "/" + relativePathNoLeadingSlash
          : relativePathNoLeadingSlash;

        if (deleteExists(relativePath)) {
          continue;
        }

        const pathDisplay = dropboxParent
          ? Path.posix.join(dropboxParent, relativePathNoLeadingSlash)
          : "/" + relativePathNoLeadingSlash;

        descendantDeletes.push({
          ".tag": "deleted",
          path_display: pathDisplay,
          relative_path: relativePath,
        });
      }

      if (descendantDeletes.length) {
        entries.splice(index + 1, 0, ...descendantDeletes);
        index += descendantDeletes.length;
      }
      // Skip past the original entry (which is now at index + 1 after parent delete insertion)
      index++;
      continue;
    }

    // For non-folder case, skip past the original entry (which is now at index + 1 after parent delete insertion)
    index++;
  }

  return entries;
}

// The goal of this function is to retrieve a list of changes made
// to the blog folder inside a user's Dropbox folder. We add a new
// property relative_path to each change. This property refers to
// the path the change relative to the folder for this blog.
module.exports = function delta(client, folderID, blogID) {
  function get(cursor, callback) {
    var requests = [];
    var result = {};

    if (cursor) {
      // We pass in a tag which tells Dropbox what we know
      // to be the previous state of a user's folder
      // so we don't get everything every time...
      requests.push(client.filesListFolderContinue({ cursor: cursor }));
    } else {
      // Dropbox likes root as empty string,
      // so if there is no folder ID this is fine
      // We obviously want to know about removed files
      // We want to know about changes anywhere in the folder
      requests.push(
        client.filesListFolder({
          path: folderID,
          include_deleted: true,
          recursive: true,
        })
      );
    }

    // folderID will be an empty string if the blog is set up as
    // root directory of the folder to which Blot has access.
    if (folderID) {
      // The reason we look up the metadata for the blog's folder
      // is to make sure we can filter the list of all changes to
      // only those made to the blog folder. We pass the ID instead
      // of the folder path because the user may rename the folder.
      requests.push(client.filesGetMetadata({ path: folderID }));
    }

    Promise.all(requests)
      .then(async function (results) {
        result = results[0].result;

        if (results[1]) {
          result.path_display = results[1].result.path_display;
        }

        // Filter entries to only those changes applied
        // to the blog folder and compute the relative
        // path of each change inside the blog folder.
        if (result.path_display) {
          const blogPath = result.path_display.replace(/\/+$/, "");

          // Dropbox can return stale/mismatched casing in delta paths
          // after a case-only rename (e.g. SiteA -> SITEA).
          const blogPathLower = blogPath.toLowerCase();
          const blogPrefix = blogPath + "/";
          const blogPrefixLower = blogPrefix.toLowerCase();

          result.entries = result.entries
            .filter(function (entry) {
              const entryPath = entry.path_display || "";

              // Compare case-insensitively so we still scope entries to
              // the correct folder when Dropbox casing lags behind.
              const entryPathLower = entryPath.toLowerCase();

              return (
                entryPathLower.startsWith(blogPrefixLower) &&
                entryPathLower !== blogPathLower
              );
            })
            .map(function (entry) {
              entry.relative_path = normalizeRelativePath(
                entry.path_display.slice(blogPath.length)
              );
              return entry;
            });
        } else {
          result.entries = result.entries.map(function (entry) {
            entry.relative_path = normalizeRelativePath(entry.path_display);
            return entry;
          });
        }

        try {
          result.entries = await injectCaseOnlyDeletes(
            result.entries,
            blogID,
            client
          );
        } catch (err) {
          debug("Error checking for case-only renames", err);
        }

        result.entries = result.entries.filter(function (entry) {
          return !isDotfileOrDotfolder(entry.relative_path);
        });

        callback(null, result);
      })

      // Handle 429 Errors from Dropbox which ask us
      // to wait a certain number of seconds before retrying
      .catch(waitForErrorTimeout)

      .catch(function (err) {
        var message, error;

        // Professional programmers wrote this SDK
        // Anyway, reset typically means the folder
        // has moved and we need to reset the cursor
        // and sync from scratch.
        if (
          err.error &&
          err.error.error &&
          err.error.error[".tag"] === "reset"
        ) {
          cursor = "";
          return get(cursor, callback);
        }

        // Determine the error message to pass back
        // to sync. We might show this to the user.
        if (err.status === 409) {
          message = "Your folder no longer exists";
        } else {
          message = "Failed to fetch changes from Dropbox";
        }

        error = new Error(message);
        error.status = err.status || 400;

        callback(error, null);
      });
  }

  // Removed the timeout since it
  return retry(get);
};
