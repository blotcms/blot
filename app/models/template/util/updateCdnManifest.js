const { promisify } = require("util");
const ensure = require("helper/ensure");
const hash = require("helper/hash");
const client = require("models/client");
const key = require("../key");
const getMetadata = require("../getMetadata");
const getView = require("../getView");
const getAllViews = require("../getAllViews");
const generateCdnUrl = require("./generateCdnUrl");
const { minifyCSS, minifyJS } = require("helper/minify");
const purgeCdnUrls = require("helper/purgeCdnUrls");
const path = require("path");
const fs = require("fs-extra");
const config = require("config");
const parseTemplate = require("../parseTemplate");
const resolveFolderLinks = require("./resolveFolderLinks");
const pathNormalizer = require("helper/pathNormalizer");
const { hashFolderFile } = require("blog/render/replaceFolderLinks/folderFile");
const {
  GLOBAL_STATIC_DIR,
  isReservedStaticPath,
} = require("blog/lib/staticPaths");

// Promisify callback-based functions
const getMetadataAsync = promisify(getMetadata);
const getAllViewsAsync = promisify(getAllViews);
const getViewAsync = promisify(getView);
const hsetAsync = client.hSet.bind(client);
const delAsync = client.del.bind(client);
const setAsync = client.set.bind(client);

// Maximum size for rendered output (2MB)
const MAX_RENDERED_OUTPUT_SIZE = 2 * 1024 * 1024;

// Base directory for rendered output storage
const RENDERED_OUTPUT_BASE_DIR = path.join(config.data_directory, "cdn", "template");


function getRenderedOutputPath(hash, viewName) {
  if (!hash || typeof hash !== "string" || hash.length < 4) {
    throw new Error("Invalid hash: must be a string with at least 4 characters");
  }
  if (!viewName || typeof viewName !== "string") {
    throw new Error("viewName must be a non-empty string");
  }
  // Use basename only for file storage (e.g., "header.html" from "partials/header.html")
  // The full path is preserved in the URL via generateCdnUrl
  const viewBaseName = path.basename(viewName);
  const dir1 = hash.substring(0, 2);
  const dir2 = hash.substring(2, 4);
  const hashRemainder = hash.substring(4);
  return path.join(RENDERED_OUTPUT_BASE_DIR, dir1, dir2, hashRemainder, viewBaseName);
}

async function writeRenderedOutputToDisk(hash, content, viewName) {
  const filePath = getRenderedOutputPath(hash, viewName);
  await fs.ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, content, "utf8");
}

async function deleteRenderedOutputFromDisk(hash, viewName) {
  const filePath = getRenderedOutputPath(hash, viewName);
  await fs.remove(filePath).catch((err) => {
    // Ignore ENOENT errors (file doesn't exist)
    if (err.code !== "ENOENT") throw err;
  });
}

function isValidTarget(target) {
  if (!target || typeof target !== "string") {
    return false;
  }

  // Reject paths containing ".." (path traversal)
  if (target.includes("..")) {
    return false;
  }

  // Reject paths containing null bytes
  if (target.includes("\0")) {
    return false;
  }

  // Reject absolute paths (starting with "/")
  if (target.startsWith("/")) {
    return false;
  }

  return true;
}

// A {{#cdn}} target can also be a file in the owner blog's folder, e.g.
// {{#cdn}}/images/a.png{{/cdn}}, whether the author wrote it or setView wrapped
// a literal link (util/resolveFolderLinks). Targets that name a view stay
// views - a template's own rendered output wins over a folder file of the same
// name. Wrapped links never resolve to a view: the author didn't ask for a
// snapshot of /feed.rss or /script.js, they just linked to it, so those are
// only ever looked up in the folder.
//
// A folder target's manifest entry is { path, version }: path is the file's
// real (case-corrected) path, version a hash of its content, from which
// retrieve/cdn.js builds %%BLOT_CDN%%/folder/v-<version>/<blogID><path> - the
// URL entries and the request-time pass use. Reserved global paths (/fonts,
// /katex, ...) are served from Blot's own static directory, have no version,
// and so no version in the entry. A view's entry stays a plain hash string, so
// existing manifests are valid as they are.
//
// A target whose file doesn't exist has no entry (the helper leaves the link
// as written) but is still a dependency of the template, so the file being
// created later regenerates the manifest. See key.templateDependents.
async function viewExists(templateID, target) {
  try {
    return !!(await getViewAsync(templateID, target));
  } catch (err) {
    const isNonFatalError =
      err.code === "ENOENT" ||
      (err.message && err.message.includes("No view:"));

    if (isNonFatalError) return false;

    throw err;
  }
}

function collectTargets(views) {
  const explicit = new Set();
  const wrapped = new Set();
  const fallbacks = {};

  const add = (set, target) => {
    if (typeof target === "string" && target.trim() && isValidTarget(target.trim())) {
      set.add(target.trim());
    }
  };

  for (const viewName in views) {
    const view = views[viewName];

    if (view?.retrieve?.cdn && Array.isArray(view.retrieve.cdn)) {
      view.retrieve.cdn.forEach((target) => add(explicit, target));
    }

    // Targets setView wrapped around literal folder links live only in the
    // resolved copy of the view, not in view.retrieve.cdn (which is derived
    // from what the author wrote).
    if (typeof view?.resolvedContent === "string") {
      const parsed = parseTemplate(view.resolvedContent);

      ((parsed.retrieve && parsed.retrieve.cdn) || []).forEach((target) =>
        add(wrapped, target)
      );

      Object.assign(fallbacks, resolveFolderLinks.rootFallbacks(view.resolvedContent));
    }
  }

  // A target the author also wrote by hand is treated as the author's
  wrapped.forEach((target) => {
    if (explicit.has(target)) wrapped.delete(target);
  });

  return { explicit, wrapped, fallbacks };
}

function normalizeDependency(filePath) {
  return pathNormalizer(filePath).toLowerCase();
}

// Looks up one candidate path ("images/a.png?x=1") for a folder target.
// Returns { requested, entry }: the path asked for (a dependency whether or
// not it exists) and its manifest entry, or null if there is no such file.
async function resolveFolderCandidate(blogFolder, candidate) {
  const cut = candidate.search(/[?#]/);
  let filePath = cut === -1 ? candidate : candidate.slice(0, cut);

  if (filePath.includes("%")) {
    try {
      filePath = decodeURIComponent(filePath);
    } catch (err) {
      // e.g. '100% luck.jpg' is malformed - use it as written
    }
  }

  const requested = path.posix.resolve("/", filePath);

  if (isReservedStaticPath(requested)) {
    try {
      await fs.stat(path.join(GLOBAL_STATIC_DIR, requested));
      return { requested, entry: { path: requested } };
    } catch (err) {
      // not a global static file - it may still be one in the blog's folder
    }
  }

  const file = await hashFolderFile(blogFolder, requested);

  return {
    requested,
    entry: file ? { path: file.path, version: file.version } : null,
  };
}

async function resolveFolderTargets(blogID, targets, fallbacks) {
  const blogFolder = path.join(config.blog_folder_dir, blogID);
  const entries = {};
  const dependencies = new Set();

  for (const target of targets) {
    // A CSS view's relative links are recorded with the root-relative path
    // they used to resolve to; it is only used if the browser-correct one is
    // missing (see resolveFolderLinks).
    const candidates = [target];

    if (fallbacks[target] && fallbacks[target] !== target) {
      candidates.push(fallbacks[target]);
    }

    for (const candidate of candidates) {
      try {
        const { requested, entry } = await resolveFolderCandidate(
          blogFolder,
          candidate
        );

        dependencies.add(normalizeDependency(requested));

        if (entry) {
          entries[target] = entry;
          break;
        }
      } catch (err) {
        console.error(`Error resolving folder target ${candidate}:`, err);
      }
    }
  }

  return { entries, dependencies };
}

// Brings the reverse index (key.templateDependents) in line with the files
// this template now depends on. Every current dependency is (re)added, not
// just new ones, so the index repairs itself if it was ever lost.
async function updateDependencyIndex(templateID, blogID, previous, current) {
  const next = Array.from(current).sort();
  const nextSet = new Set(next);
  const removed = (previous || []).filter((file) => !nextSet.has(file));

  if (!next.length && !removed.length && !(previous || []).length) return;

  const multi = client.multi();

  next.forEach((file) => multi.sAdd(key.templateDependents(blogID, file), templateID));
  removed.forEach((file) => multi.sRem(key.templateDependents(blogID, file), templateID));

  await multi.exec();

  if (JSON.stringify(next) !== JSON.stringify(previous || [])) {
    await hsetAsync(key.metadata(templateID), "fileDependencies", JSON.stringify(next));
  }
}

/**
 * Process a single CDN target and build its manifest entry
 */
async function processTarget(
  templateID,
  target
) {

  // require here becuse of dependency loop
  const renderView = require("blog/render/view");

  // Check if view exists
  try {
    const view = await getViewAsync(templateID, target);
    if (!view) {
      return null;
    }
  } catch (err) {
    // Treat ENOENT errors and "No view:" errors as non-fatal
    const isNonFatalError =
      err.code === "ENOENT" ||
      (err.message && err.message.includes("No view:"));
    
    if (isNonFatalError) {
      return null;
    }
    
    throw err;
  }

  // Render the view to get output
  const renderedOutput = await renderView(templateID, target);
  
  if (renderedOutput === undefined || renderedOutput === null) {
    return null; // Missing view or render error - skip in manifest
  }

  const renderedOutputString =
    typeof renderedOutput === "string" ? renderedOutput : String(renderedOutput);

  // Validate rendered output size
  if (renderedOutputString.length > MAX_RENDERED_OUTPUT_SIZE) {
    console.error(
      `Rendered output for ${target} exceeds maximum size (${renderedOutputString.length} bytes > ${MAX_RENDERED_OUTPUT_SIZE} bytes)`
    );
    return null;
  }

  // Compute hash from templateID + view name + rendered output
  // We include the template ID and view name to ensure that hashes are unique per site
  // and per view because we purge the old hash when this changes.
  const hashInput = templateID + ":" + target + ":" + renderedOutputString;
  const computedHash = hash(hashInput);

  const ext = path.extname(target).toLowerCase();
  let contentToWrite = renderedOutputString;

  try {
    if (ext === ".css") {
      contentToWrite = minifyCSS(renderedOutputString);
    } else if (ext === ".js") {
      contentToWrite = await minifyJS(renderedOutputString);
    }
  } catch (err) {
    console.error(`Error minifying rendered output for ${target}:`, err);
    contentToWrite = renderedOutputString;
  }

  // Store rendered output on disk and in Redis (for backward compatibility during migration)
  const renderedKey = key.renderedOutput(computedHash);
  try {
    // Write to disk (primary storage) with original view name
    await writeRenderedOutputToDisk(computedHash, contentToWrite, target);

    // Also write to Redis for backward compatibility during migration period
    await setAsync(renderedKey, contentToWrite);
  } catch (err) {
    console.error(`Error storing rendered output for ${target}:`, err);
    return null; // Don't create manifest entry if storage fails
  }

  return computedHash;
}

/**
 * Clean up old rendered output and purge CDN URL
 */
async function cleanupOldHash(target, oldHash) {
  if (!oldHash || typeof oldHash !== 'string') return;
  
  try {
    // Delete from disk using original view name
    await deleteRenderedOutputFromDisk(oldHash, target);
    
    // Delete from Redis
    const oldRenderedKey = key.renderedOutput(oldHash);
    await delAsync(oldRenderedKey);
    
    // Background purge CDN URL from Bunny in background (not important)
    // if it fails, worst case we pay to store a stale file. the url used
    // on the site changes over to the new version so no worries.
    const oldUrl = generateCdnUrl(target, oldHash);
    purgeCdnUrls([oldUrl]);
  } catch (err) {
    console.error(`Error cleaning up old hash for ${target}:`, err);
  }
}

module.exports = function updateCdnManifest(templateID, callback) {
  callback = callback || function () {};

  (async () => {
    try {
      ensure(templateID, "string");
    } catch (err) {
      return callback(err);
    }

    try {
      const metadata = await getMetadataAsync(templateID);

      if (!metadata) {
        return callback(new Error("Template metadata not found"));
      }

      if (!metadata.owner) {
        return callback(new Error("Template metadata missing owner"));
      }

      // Immediately exit without changes if the template is owned by SITE
      if (metadata.owner === "SITE") {
        return callback(null, metadata.cdn || {});
      }

      const oldManifest =
        metadata && typeof metadata.cdn === "object" ? metadata.cdn : {};

      // Skip CDN manifest computation when the template is not installed on the owner blog.
      //
      // Safety: Templates are siloed per blog and preview subdomains do not use CDN manifests
      // for non-SITE templates (see app/blog/render/retrieve/cdn.js lines 12-15). There is no
      // other way to view a template that isn't installed on a blog, so the manifest would go
      // unused.
      // Require Blog.get here to avoid dependency loops
      const Blog = require("models/blog");
      const getBlogAsync = promisify(Blog.get);

      const blog = await getBlogAsync({ id: metadata.owner });
      const templateInstalled = blog && blog.template === templateID;

      if (!templateInstalled) {
        metadata.cdn = {};
        await hsetAsync(key.metadata(templateID), "cdn", JSON.stringify({}));

        for (const target in oldManifest) {
          await cleanupOldHash(target, oldManifest[target]);
        }

        await updateDependencyIndex(
          templateID,
          metadata.owner,
          metadata.fileDependencies,
          []
        );

        return callback(null, {});
      }

      // Get all views and collect their CDN targets
      const views = await getAllViewsAsync(templateID);
      const { explicit, wrapped, fallbacks } = collectTargets(views);

      const sortedTargets = [];
      const folderTargets = new Set(wrapped);

      for (const target of Array.from(explicit).sort()) {
        if (await viewExists(templateID, target)) {
          sortedTargets.push(target);
        } else {
          folderTargets.add(target);
        }
      }

      const manifest = {};
      const inProgressManifest = {};

      // Rendered views keep their previous hash until they are re-rendered
      for (const target in oldManifest) {
        if (typeof oldManifest[target] === "string") {
          inProgressManifest[target] = oldManifest[target];
        }
      }

      // Folder files go first, and are saved before any view is rendered:
      // renderView reads the manifest back from Redis, so a stylesheet that
      // links to /images/a.png renders with its new URL and gets a new hash
      // when the image changes.
      const folder = await resolveFolderTargets(
        metadata.owner,
        Array.from(folderTargets).sort(),
        fallbacks
      );

      for (const target of folderTargets) {
        if (folder.entries[target]) {
          manifest[target] = folder.entries[target];
          inProgressManifest[target] = folder.entries[target];
        } else {
          delete inProgressManifest[target];
        }
      }

      metadata.cdn = inProgressManifest;

      if (JSON.stringify(inProgressManifest) !== JSON.stringify(oldManifest)) {
        await hsetAsync(
          key.metadata(templateID),
          "cdn",
          JSON.stringify(inProgressManifest)
        );
      }

      await updateDependencyIndex(
        templateID,
        metadata.owner,
        metadata.fileDependencies,
        folder.dependencies
      );

      // Process each target sequentially
      for (const target of sortedTargets) {
        try {
          let manifestChanged = false;
          const result = await processTarget(
            templateID,
            target
          );
          if (result && typeof result === 'string') {
            manifest[target] = result;
            const previousHash = inProgressManifest[target];
            inProgressManifest[target] = result;
            if (previousHash !== result) {
              manifestChanged = true;
            }

            // Clean up old hash if it changed
            const oldHash = oldManifest[target];
            if (oldHash && oldHash !== result && typeof oldHash === 'string') {
              // Run cleanup in background - don't await
              cleanupOldHash(target, oldHash).catch(err => {
                // Error already logged in cleanupOldHash, but catch to prevent unhandled rejection
              });
            }
          } else {
            if (Object.prototype.hasOwnProperty.call(inProgressManifest, target)) {
              delete inProgressManifest[target];
              manifestChanged = true;
            }
          }

          if (manifestChanged) {
            await hsetAsync(
              key.metadata(templateID),
              "cdn",
              JSON.stringify(inProgressManifest)
            );
          }
        } catch (err) {
          console.error(`Error processing CDN target ${target}:`, err);
        }
      }

      // Clean up rendered outputs for targets that were removed entirely
      for (const target in oldManifest) {
        if (typeof manifest[target] !== "string") {
          // Run cleanup in background - don't await
          cleanupOldHash(target, oldManifest[target]).catch(err => {
            // Error already logged in cleanupOldHash, but catch to prevent unhandled rejection
          });
        }
      }

      // Save manifest to Redis
      await hsetAsync(key.metadata(templateID), "cdn", JSON.stringify(manifest));
      
      callback(null, manifest);
    } catch (err) {
      callback(err);
    }
  })();
};
