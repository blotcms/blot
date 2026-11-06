const join = require("path").join;
const fs = require("fs-extra");
const config = require("config");
const basename = require("path").basename;
const DIR = require("helper/rootDir") + "/app/templates/folders";
const folder = require("storage/folder");
const hashFile = require("helper/hashFile");
const sync = require("sync");
const { promisify } = require("util");
const fix = promisify(require("sync/fix"));
const lock = require("helper/lock");
const syncReport = require("clients/util/syncReport");

const setupUser = require("./setupUser");
const setupBlogs = require("./setupBlogs");
const demoFolders = require("../demoFolders");

// Compares the directory sourcePath with the folder of the blog blogID
async function getChangedFiles(sourcePath, blogID) {
  const changes = {
    modified: new Set(),
    added: new Set(),
    removed: new Set(),
  };

  // Get all files in source and destination recursively
  async function getAllFiles(dir) {
    const results = new Set();
    const items = await fs.readdir(dir, { withFileTypes: true });
    for (const item of items) {
      const fullPath = join(dir, item.name);
      if (item.isDirectory()) {
        const subFiles = await getAllFiles(fullPath);
        subFiles.forEach((f) => results.add(f));
      } else {
        results.add(fullPath);
      }
    }
    return results;
  }

  const sourceFiles = await getAllFiles(sourcePath);
  const destFiles = new Set();

  for await (const relPath of folder.walk(blogID, "/")) {
    destFiles.add(relPath);
  }

  // Check for modified and added files
  for (const sourceFile of sourceFiles) {
    const relPath = sourceFile.slice(sourcePath.length);

    if (!destFiles.has(relPath)) {
      changes.added.add(relPath);
    } else {
      try {
        const [sourceHash, dest] = await Promise.all([
          hashFile(sourceFile),
          folder.stat(blogID, relPath, { hash: true }),
        ]);
        if (sourceHash !== dest.hash) {
          changes.modified.add(relPath);
        }
      } catch (err) {
        changes.modified.add(relPath);
      }
    }
  }

  // Check for removed files
  for (const relPath of destFiles) {
    const sourceFile = join(sourcePath, relPath);
    if (!sourceFiles.has(sourceFile)) {
      changes.removed.add(relPath);
    }
  }

  return changes;
}

async function syncFolder(sourcePath, blogID) {
  await folder.mkdir(blogID, "/");

  // Copy changed files
  const changes = await getChangedFiles(sourcePath, blogID);

  for (const relPath of [...changes.added, ...changes.modified]) {
    await folder.writeFrom(blogID, relPath, join(sourcePath, relPath));
  }

  // Remove deleted files
  for (const relPath of changes.removed) {
    await folder.remove(blogID, relPath);
  }

  return changes;
}

async function loadFoldersToBuild(foldersDirectory) {
  const items = await fs.readdir(foldersDirectory);
  return items
    .map((name) => join(foldersDirectory, name))
    .filter((path) => {
      const name = basename(path);
      return (
        name[0] !== "-" && name[0] !== "." && fs.statSync(path).isDirectory()
      );
    });
}

async function applyChanges(blog, changes) {
  return new Promise((resolve, reject) => {
    sync(blog.id, async function (err, folder, done) {
      if (err) return reject(err);

      const update = promisify(folder.update);

      try {
        // Update only modified and added files
        const changedPaths = [
          ...changes.modified,
          ...changes.added,
          ...changes.removed,
        ];
        for (const relativePath of changedPaths) {
          await update(relativePath);
        }

        const repaired = syncReport.summarize(await fix(blog));
        if (repaired) console.log("Fix repaired", blog.handle, repaired);
        console.log("Built folder for blog", blog.handle);
        done(null, resolve);
      } catch (err) {
        console.error("Error building folder for blog", blog.handle, err);
        done(null, () => {
          reject(err);
        });
      }
    });
  });
}

async function build(options = {}) {
  let folders = await loadFoldersToBuild(DIR);

  if (options.templates !== undefined) {
    // Screenshotting a template only needs the one folder it is previewed on,
    // so let callers name templates instead of working out the folders.
    const wanted = demoFolders.forTemplates(
      demoFolders.parse(options.templates)
    );
    console.log("Building folders for templates:", wanted.join(", "));
    folders = folders.filter((path) => wanted.includes(basename(path)));
  }

  if (options.filter) {
    folders = folders.filter(options.filter);
  }

  const { user, url } = await setupUser();
  console.log(
    "Established user " + user.email + " to manage demonstration blogs"
  );

  const blogs = await setupBlogs(user, folders);

  // Update and sync blogs
  for (const [blogID, { path, blog }] of Object.entries(blogs)) {
    try {
      console.log("Building folder", path, "for blog", blog.handle);

      // Sync changed files and get list of changes
      const changes = await syncFolder(path, blogID);

      // Only update changed files
      await applyChanges(blog, changes);
    } catch (e) {
      console.error("Error syncing folder", path, "for blog", blog.handle, e);
    }
  }

  folders.forEach((folder) => {
    console.log("http://" + basename(folder) + "." + config.host);
    console.log("Folder:", folder);
    console.log();
  });

  console.log("Dashboard:\n" + url);
}

// Like templates(), wait for the lock (retries with backoff, about 95s in
// total) rather than skip: an overlapping invocation may have asked for a
// different folder selection, and a slow Redis reply (ESLOW) doesn't mean
// anyone else holds the lock. If it still can't be acquired, build anyway.
// Folders are idempotent (hash compare), so a duplicate build is cheap and
// better than a skipped one.
async function main(options = {}) {
  let held = null;

  try {
    held = await lock("templates:folders", {
      ttl: 60 * 1000,
      heartbeat: 10 * 1000,
      retries: 7,
      onCompromised: (err) =>
        console.error("[templates:folders] lock compromised:", err.message),
    });
  } catch (e) {
    console.error(
      e.code === "ELOCKED"
        ? "[templates:folders] lock still held after waiting, building anyway"
        : "[templates:folders] lock unavailable, building anyway: " + e.message
    );
  }

  try {
    return await build(options);
  } finally {
    if (held) {
      await held.release().catch((e) => {
        console.error("[templates:folders] lock release failed:", e.message);
      });
    }
  }
}

if (require.main === module) {
  const options = {};
  const args = process.argv.slice(2);
  const forTemplates = args
    .find((arg) => arg.startsWith("--for-templates="))
    ?.slice("--for-templates=".length);
  const positional = args.find((arg) => !arg.startsWith("--"));

  if (forTemplates) {
    options.templates = forTemplates;
  } else if (positional) {
    options.filter = (path) => path.includes(positional);
  }

  main(options)
    .catch((err) => {
      console.error(err);
      process.exit(1);
    })
    .then(() => {
      process.exit(0);
    });
}

module.exports = main;
