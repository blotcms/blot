const join = require("path").join;
const fs = require("fs-extra");
const config = require("config");
const basename = require("path").basename;
const DIR = require("helper/rootDir") + "/app/templates/folders";
const folder = require("storage/folder");
const hashFile = require("helper/hashFile");
const sync = require("sync");
const fix = require("sync/fix");
const lock = require("helper/lock");
const syncReport = require("clients/util/syncReport");

const setupUser = require("./setupUser");
const setupBlogs = require("./setupBlogs");
const demoFolders = require("../demoFolders");
const publishZip = require("./publishZip");

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
  await sync(blog.id, async function (folder) {
    const update = folder.update;

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
    } catch (err) {
      console.error("Error building folder for blog", blog.handle, err);
      throw err;
    }
  });
}

// options:
//   from       the directory holding the folders (default: the ones in this
//              checkout). The deploy step sends the folders to the host and
//              passes their directory (scripts/deploy/demo-folders.js). A
//              config.js there replaces this directory's.
//   only       folder names to build, all others are skipped
//   zip        also upload each folder's download ZIP (./publishZip)
//   templates  template names: build the folders they're previewed on
//   filter     a function of the folder's path
// Resolves once every folder is built. A folder that fails is logged and the
// rest are still built; with from set, build then rejects, so the deploy
// step fails and doesn't record the folder as done.
async function build(options = {}) {
  let folders = await loadFoldersToBuild(options.from || DIR);

  if (options.only !== undefined) {
    const missing = options.only.filter(
      (name) => !folders.some((path) => basename(path) === name)
    );
    if (missing.length)
      throw new Error("No such demo folders: " + missing.join(", "));
    folders = folders.filter((path) => options.only.includes(basename(path)));
  }

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

  // The deploy sends the commit's config.js with its folders: the running
  // image's copy may be older (scripts/deploy/demo-folders.js)
  const sentConfig = options.from && join(options.from, "config.js");
  const settings =
    sentConfig && (await fs.pathExists(sentConfig))
      ? require(sentConfig)
      : undefined;

  const blogs = await setupBlogs(user, folders, { settings });

  const failed = [];

  // Update and sync blogs
  for (const [blogID, { path, blog }] of Object.entries(blogs)) {
    try {
      console.log("Building folder", path, "for blog", blog.handle);

      // Sync changed files and get list of changes
      const changes = await syncFolder(path, blogID);

      // Only update changed files
      await applyChanges(blog, changes);

      if (options.zip) {
        const zip = await publishZip(basename(path), path);
        console.log(
          (zip.uploaded ? "Uploaded " : "Already uploaded ") + zip.key,
          zip.removed.length ? "and removed " + zip.removed.join(", ") : ""
        );
      }
    } catch (e) {
      console.error("Error syncing folder", path, "for blog", blog.handle, e);
      failed.push(basename(path));
    }
  }

  folders.forEach((folder) => {
    console.log("http://" + basename(folder) + "." + config.host);
    console.log("Folder:", folder);
    console.log();
  });

  if (url) console.log("Dashboard:\n" + url);

  if (failed.length && options.from)
    throw new Error("Failed to build demo folders: " + failed.join(", "));
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
  const valueOf = (name) => {
    const index = args.indexOf(name);
    return index === -1 ? undefined : args[index + 1];
  };
  const from = valueOf("--from");
  const only = valueOf("--only");
  const positional = args.find(
    (arg, i) =>
      !arg.startsWith("--") && !["--from", "--only"].includes(args[i - 1])
  );

  if (from) options.from = require("path").resolve(from);
  if (only) options.only = only.split(",").filter(Boolean);
  if (args.includes("--zip")) options.zip = true;

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
