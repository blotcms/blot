const config = require("config");
const { join, dirname, basename, extname } = require("path");
const fs = require("fs-extra");
const crypto = require("crypto");
const chokidar = require("chokidar");
const html = require("./html");
const favicon = require("./favicon");
const recursiveReadDir = require("../../helper/recursiveReadDirSync");
const clfdate = require("helper/clfdate");

const SOURCE_DIRECTORY = join(__dirname, "../../views");
const DESTINATION_DIRECTORY = config.views_directory;

const buildCSS = require("./css")({
  source: SOURCE_DIRECTORY,
  destination: DESTINATION_DIRECTORY,
});
const buildJS = require("./js")({
  source: SOURCE_DIRECTORY,
  destination: DESTINATION_DIRECTORY,
});

const zip = require("templates/folders/zip");
const tools = require("./tools");
const templates = require("./templates");
const generateThumbnail = require("./generate-thumbnail");
const gitCommits = require("../tools/git-commits").build;

// Cache-related functions (development only)
async function computeViewsHash() {
  const files = recursiveReadDir(SOURCE_DIRECTORY);
  const hash = crypto.createHash("sha256");

  // Hash all files in the views directory
  for (const file of files) {
    const stat = await fs.stat(file);
    const relativePath = file.slice(SOURCE_DIRECTORY.length + 1);
    hash.update(relativePath);
    hash.update(stat.mtime.getTime().toString());
    hash.update(stat.size.toString());
  }

  // Also hash build scripts that affect the output
  const buildScripts = [
    join(__dirname, "css.js"),
    join(__dirname, "js.js"),
    join(__dirname, "html.js"),
    join(__dirname, "tools.js"),
    join(__dirname, "templates.js"),
    join(__dirname, "pageSpecificAssets.js"),
    join(__dirname, "../tools/git-commits.js"),
    join(__dirname, "../tools/hljs.js"),
    join(__dirname, "../tools/finder/build.js"),
  ];

  for (const script of buildScripts) {
    try {
      if (await fs.pathExists(script)) {
        const stat = await fs.stat(script);
        const relativePath = script.slice(__dirname.length + 1);
        hash.update(relativePath);
        hash.update(stat.mtime.getTime().toString());
        hash.update(stat.size.toString());
      }
    } catch (e) {
      // Ignore errors for missing files
    }
  }

  return hash.digest("hex");
}

async function restoreFromCache(cacheDir) {
  if (fs.pathExistsSync(cacheDir)) {
    console.log(clfdate(), "Restoring documentation from cache");
    fs.copySync(cacheDir, DESTINATION_DIRECTORY);
    console.log(clfdate(), "Cache restored");
    return true;
  }
  return false;
}

async function saveToCache(cacheDir) {
  await fs.ensureDir(cacheDir);
  await fs.copy(DESTINATION_DIRECTORY, cacheDir);
  console.log(clfdate(), "Documentation cache saved");
}

async function cleanOldCaches(cacheRoot, currentHash) {
  try {
    const entries = await fs.readdir(cacheRoot);
    for (const entry of entries) {
      if (entry !== currentHash) {
        const oldCachePath = join(cacheRoot, entry);
        await fs.remove(oldCachePath);
        console.log(clfdate(), "Removed old cache:", entry);
      }
    }
  } catch (e) {
    // Ignore errors when cleaning old caches
  }
}

const handle =
  (initial = false, cacheDir = null) =>
  async (path) => {
    try {
      if (path.endsWith("README")) {
        return;
      }

      if (path.includes("tools/")) {
        if (initial) return;
        console.log("Rebuilding tools");
        await tools();
        return;
      }

      if (path.startsWith("templates/")) {
        if (initial) return;
        console.log("Rebuilding templates pages");
        await templates();
        return;
      }

      if (path.includes("images/examples") && path.endsWith(".png")) {
        await fs.copy(
          join(SOURCE_DIRECTORY, path),
          join(DESTINATION_DIRECTORY, path)
        );
        await generateThumbnail(
          join(SOURCE_DIRECTORY, path),
          join(
            DESTINATION_DIRECTORY,
            dirname(path),
            basename(path, extname(path)) + "-thumb.png"
          )
        );
        await generateThumbnail(
          join(SOURCE_DIRECTORY, path),
          join(
            DESTINATION_DIRECTORY,
            dirname(path),
            basename(path, extname(path)) + "-icon.png"
          ),
          { width: 48 }
        );
      } else if (path.endsWith(".html") && !path.includes("dashboard/")) {
        await buildHTML(path);
      } else if (path.endsWith(".css") && !initial) {
        await fs.copy(
          join(SOURCE_DIRECTORY, path),
          join(DESTINATION_DIRECTORY, path)
        );
        await buildCSS();
      } else if (path.endsWith(".js") && !initial) {
        await fs.copy(
          join(SOURCE_DIRECTORY, path),
          join(DESTINATION_DIRECTORY, path)
        );
        await buildJS();
      } else {
        await fs.copy(
          join(SOURCE_DIRECTORY, path),
          join(DESTINATION_DIRECTORY, path)
        );
      }

      // After partial rebuild, update cache if in development
      if (!initial && config.environment === "development") {
        const hash = await computeViewsHash();
        const cacheRoot = join(config.tmp_directory, "documentation-cache");
        const currentCacheDir = join(cacheRoot, hash, "views-built");
        await saveToCache(currentCacheDir);
        await cleanOldCaches(cacheRoot, hash);
      }
    } catch (e) {
      console.error(e);
    }
  };

module.exports = async ({ watch = false, skipZip = false } = {}) => {
  const now = Date.now();

  let cacheDir = null;
  let cacheRestored = false;

  // Cache logic (development only)
  let hash = null;
  
  if (config.environment === "development") {
    hash = await computeViewsHash();
    const cacheRoot = join(config.tmp_directory, "documentation-cache");
    cacheDir = join(cacheRoot, hash, "views-built");

    // Try to restore from cache before expensive build steps
    cacheRestored = await restoreFromCache(cacheDir);
  }

  // we only reset the destination directory in production
  if (config.environment !== "development") {
    await fs.emptyDir(DESTINATION_DIRECTORY);
  } else {
    await fs.ensureDir(DESTINATION_DIRECTORY);
  }

  // Only run expensive build steps if cache was not restored
  if (!cacheRestored) {
    if (!skipZip) await zip();

    await favicon(
      join(SOURCE_DIRECTORY, "images/logo.svg"),
      join(DESTINATION_DIRECTORY, "favicon.ico")
    );

    const paths = recursiveReadDir(SOURCE_DIRECTORY).map((path) =>
      path.slice(SOURCE_DIRECTORY.length + 1)
    );

    const initialHandler = handle(true, cacheDir);

    await Promise.all(paths.map(initialHandler));

    await tools();
    await templates();

    await buildCSS();

    await buildJS();

    try {
      console.log(
        clfdate(),
        "Generating list of recent activity for the news page"
      );
      await gitCommits();
      console.log(
        clfdate(),
        "Generated list of recent activity for the news page"
      );
    } catch (e) {
      console.error(
        "Failed to generate list of recent activity for the news page"
      );
      console.error(e);
    }

    // Save to cache after full rebuild (development only)
    if (config.environment === "development" && cacheDir && hash) {
      await saveToCache(cacheDir);
      const cacheRoot = join(config.tmp_directory, "documentation-cache");
      await cleanOldCaches(cacheRoot, hash);
    }
  }

  console.log(
    clfdate(),
    "Build completed in",
    (Date.now() - now) / 1000,
    "seconds"
  );

  if (watch) {
    const handler = handle(false, cacheDir);

    chokidar
      .watch(SOURCE_DIRECTORY, {
        cwd: SOURCE_DIRECTORY,
        ignoreInitial: true,
      })
      .on("all", async (event, path) => {
        if (path) handler(path);
      });
  }
};

async function buildHTML(path) {
  const contents = await fs.readFile(join(SOURCE_DIRECTORY, path), "utf-8");
  const result = await html(contents, { path });

  await fs.outputFile(join(DESTINATION_DIRECTORY, path), result);
}

if (require.main === module) {
  console.log("Building documentation");
  module.exports();
  console.log("Documentation built");
}
