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

// templates.js renders its output from this directory as well as
// SOURCE_DIRECTORY (see templatesSourceDirectory in templates.js). It must
// be part of the cache's fingerprint below, or a change here goes
// undetected and a stale cache gets restored on top of it.
const TEMPLATES_SOURCE_DIRECTORY = join(__dirname, "../../templates/source");

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

// Cache-related functions (development only).
//
// Decision on partial/targeted build helpers (e.g. running templates.js
// directly for fast local iteration, or the "templates/" branch of the
// watcher handler below): they are not made to update the cache
// themselves, and the cache-restore path does not try to detect drift by
// inspecting the destination. Instead, computeViewsHash() is required to
// cover every input a helper reads from, so the hash is a complete
// fingerprint of the build - a given hash can only ever correspond to one
// possible output. Restoring a cache entry for a matching hash is then
// always correct, and running a helper directly can't leave the
// destination in a state a full rebuild wouldn't already produce for that
// same hash. If a new build script starts reading from another directory,
// that directory needs to be added to computeViewsHash() (or the script
// added to buildScripts below), the same way TEMPLATES_SOURCE_DIRECTORY was.
async function hashDirectory(hash, directory) {
  if (!(await fs.pathExists(directory))) return;

  const files = recursiveReadDir(directory);

  for (const file of files) {
    const stat = await fs.stat(file);
    const relativePath = file.slice(directory.length + 1);
    hash.update(relativePath);
    hash.update(stat.mtime.getTime().toString());
    hash.update(stat.size.toString());
  }
}

async function computeViewsHash() {
  const hash = crypto.createHash("sha256");

  // Hash all files in the views directory
  await hashDirectory(hash, SOURCE_DIRECTORY);

  // templates.js also reads from here (see loadTemplates in templates.js),
  // so it must affect the cache's fingerprint too.
  await hashDirectory(hash, TEMPLATES_SOURCE_DIRECTORY);

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
  // A cache directory may already exist when a watcher refreshes a cache
  // with the same source hash. Remove files from the previous snapshot so
  // generated output cannot remain stale in the refreshed cache.
  await fs.emptyDir(cacheDir);
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

async function refreshDevelopmentCache() {
  if (config.environment !== "development") return null;

  const hash = await computeViewsHash();
  const cacheRoot = join(config.tmp_directory, "documentation-cache");
  const cacheDir = join(cacheRoot, hash, "views-built");

  await saveToCache(cacheDir);
  await cleanOldCaches(cacheRoot, hash);

  return { hash, cacheDir };
}

// Two builds that share a cache directory (same views hash) crash in
// saveToCache. fs-extra's emptyDir/remove is Node's fs.rm, and fs.rm's
// rmdir throws ENOTEMPTY when the other build is still copying files into
// that directory. cleanOldCaches swallows the error; saveToCache does not,
// so the rejection kills the process (nodemon restart overlapping a build,
// or two build() calls). The same overlap also deletes files out from under
// fs.copy (ENOENT) and leaves a partial cache that a later restore trusts.
// A mkdir lock covers both a second call in this process and a second process.
const BUILD_LOCK_WAIT_MS = 50;
const BUILD_LOCK_TIMEOUT_MS = 10 * 60 * 1000;
const BUILD_LOCK_FRESH_MS = 1000;

function documentationBuildLockPath() {
  return join(config.tmp_directory, "documentation-build.lock");
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

// /proc/<pid>/stat field 22 is the process start time. A recycled pid has a
// different start time, so a lock whose holder has exited can be reclaimed
// even when the numeric pid now belongs to an unrelated process.
function processStartTicks(pid) {
  try {
    const stat = fs.readFileSync("/proc/" + pid + "/stat", "utf8");
    const rest = stat.slice(stat.lastIndexOf(")") + 2);
    return rest.split(" ")[19] || "";
  } catch (err) {
    return "";
  }
}

function currentLockToken() {
  const start = processStartTicks(process.pid);
  return start ? process.pid + ":" + start : String(process.pid);
}

function lockTokenIsLive(token) {
  const [pidText, start] = String(token || "").split(":");
  const pid = parseInt(pidText, 10);
  if (!processIsAlive(pid)) return false;
  if (!start) return true;
  const now = processStartTicks(pid);
  if (!now) return true;
  return now === start;
}

async function readLockOwner(lockPath) {
  return String(await fs.readFile(join(lockPath, "pid"), "utf8").catch(() => "")).trim();
}

function releaseDocumentationBuildLock(lockPath) {
  return async function release() {
    if ((await readLockOwner(lockPath)) !== currentLockToken()) return;
    await fs.remove(lockPath);
  };
}

// Claim the existing directory in place. Renaming it aside would let another
// waiter mkdir a new lock, then have this waiter's rename move that live lock
// out from under them. The exclusive claim file is the revalidation: only one
// waiter creates it, and it adopts the directory only if the owner token is
// still the dead one it observed.
async function takeOverStaleLock(lockPath, observedToken) {
  const claimPath = join(lockPath, "claim");
  try {
    await fs.writeFile(claimPath, currentLockToken(), { flag: "wx" });
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
    const claimStat = await fs.stat(claimPath).catch(() => null);
    const claimToken = String(await fs.readFile(claimPath, "utf8").catch(() => "")).trim();
    const claimFresh = claimStat && Date.now() - claimStat.mtimeMs < BUILD_LOCK_FRESH_MS;
    if (!lockTokenIsLive(claimToken) && !claimFresh) {
      await fs.remove(claimPath).catch(() => {});
    }
    return false;
  }

  try {
    const tokenNow = await readLockOwner(lockPath);
    if (tokenNow !== observedToken || lockTokenIsLive(tokenNow)) return false;
    if (!tokenNow) {
      const stat = await fs.stat(lockPath).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs < BUILD_LOCK_FRESH_MS) return false;
    }
    await fs.writeFile(join(lockPath, "pid"), currentLockToken());
    return true;
  } finally {
    await fs.remove(claimPath).catch(() => {});
  }
}

async function acquireDocumentationBuildLock() {
  const lockPath = documentationBuildLockPath();
  await fs.ensureDir(config.tmp_directory);
  const deadline = Date.now() + BUILD_LOCK_TIMEOUT_MS;

  for (;;) {
    try {
      // mkdir is atomic, so two builders cannot both enter this section.
      await fs.mkdir(lockPath);
      await fs.writeFile(join(lockPath, "pid"), currentLockToken());
      return releaseDocumentationBuildLock(lockPath);
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
    }

    const stat = await fs.stat(lockPath).catch(() => null);
    if (!stat) continue;

    if (!stat.isDirectory()) {
      await fs.remove(lockPath).catch(() => {});
      continue;
    }

    const ownerText = await readLockOwner(lockPath);
    const freshEmpty = !ownerText && Date.now() - stat.mtimeMs < BUILD_LOCK_FRESH_MS;
    if (!lockTokenIsLive(ownerText) && !freshEmpty) {
      if (await takeOverStaleLock(lockPath, ownerText)) {
        return releaseDocumentationBuildLock(lockPath);
      }
    }

    if (Date.now() > deadline) {
      const error = new Error(
        "Timed out waiting for the documentation build lock (holder " +
          (ownerText || "unknown") +
          ")"
      );
      error.code = "ELOCKED";
      throw error;
    }

    await new Promise((resolve) => setTimeout(resolve, BUILD_LOCK_WAIT_MS));
  }
}

function withDocumentationBuildLock(task) {
  return acquireDocumentationBuildLock().then(async (release) => {
    try {
      return await task();
    } finally {
      await release();
    }
  });
}

async function rebuildTools() {
  console.log("Rebuilding tools");
  await tools();
  await refreshDevelopmentCache();
}

const handle =
  (initial = false, cacheDir = null, options = {}) =>
  async (path) => {
    try {
      if (path.endsWith("README")) {
        return;
      }

      if (path.includes("tools/")) {
        if (initial) return;
        await rebuildTools();
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

      // After partial rebuild, update cache if in development. A watcher
      // batch defers this so one burst does not copy the whole output once
      // per file.
      if (!initial && !options.deferCache && config.environment === "development") {
        await refreshDevelopmentCache();
      }
    } catch (e) {
      console.error(e);
    }
  };

async function buildDocumentation({ watch = false, skipZip = false } = {}) {
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

  // Tool pages are generated from a directory of source files, so a cache
  // snapshot can be stale even when its source hash matches. Refresh this
  // generated subtree after restoring a development cache before starting
  // the watcher. The rest of the documentation can still use the cache.
  if (cacheRestored) {
    await rebuildTools();
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
    await refreshDevelopmentCache();
  }

  console.log(
    clfdate(),
    "Build completed in",
    (Date.now() - now) / 1000,
    "seconds"
  );

  if (watch) {
    const handler = handle(false, cacheDir, { deferCache: true });
    // One queue for the whole burst. Each chokidar event used to start its
    // own lock wait, so a branch switch could time out later files with
    // ELOCKED before they were rebuilt.
    const enqueue = createWatchQueue(async (batch) => {
      await withDocumentationBuildLock(async () => {
        for (const filePath of batch) await handler(filePath);
        if (config.environment === "development") {
          await refreshDevelopmentCache();
        }
      });
    });

    chokidar
      .watch(SOURCE_DIRECTORY, {
        cwd: SOURCE_DIRECTORY,
        ignoreInitial: true,
      })
      .on("all", (event, filePath) => {
        enqueue(filePath);
      });
  }
}

function createWatchQueue(runBatch) {
  const pending = [];
  let draining = false;
  let drainPromise = null;

  function enqueue(filePath) {
    if (filePath) pending.push(filePath);
    if (draining) return drainPromise;

    draining = true;
    drainPromise = (async () => {
      let failed = false;
      try {
        while (pending.length && !failed) {
          const batch = [...new Set(pending.splice(0, pending.length))];
          try {
            await runBatch(batch);
          } catch (err) {
            console.error(err);
            pending.unshift(...batch);
            failed = true;
          }
        }
      } finally {
        draining = false;
        drainPromise = null;
        if (pending.length && !failed) enqueue();
      }
    })();

    return drainPromise;
  }

  return enqueue;
}

module.exports = (options) =>
  withDocumentationBuildLock(() => buildDocumentation(options));

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

module.exports.computeViewsHash = computeViewsHash;
module.exports.rebuildTools = () => withDocumentationBuildLock(rebuildTools);
module.exports.createWatchQueue = createWatchQueue;
