const { promisify } = require("util");
const ensure = require("helper/ensure");
const hash = require("helper/hash");
const client = require("models/client");
const key = require("../key");
const getMetadata = require("../getMetadata");
const getView = require("../getView");
const getAllViews = require("../getAllViews");
const parseTemplate = require("../parseTemplate");
const generateCdnUrl = require("./generateCdnUrl");
const { minifyCSS, minifyJS } = require("helper/minify");
const purgeCdnUrls = require("helper/purgeCdnUrls");
const path = require("path");
const fs = require("fs-extra");
const config = require("config");
const pathNormalizer = require("helper/pathNormalizer");
const blogHosts = require("blog/lib/blogHosts");
const {
  wrapFolderLinks,
  wrapInlinePartial,
  mapFolderLocals,
  folderTarget,
} = require("./resolveFolderLinks");
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

// Maximum size for rendered output (2MB)
const MAX_RENDERED_OUTPUT_SIZE = 2 * 1024 * 1024;

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
// {{#cdn}}/images/a.png{{/cdn}}, whether the author wrote it or the render
// wraps a literal link (util/resolveFolderLinks). Targets that name a view
// stay views - a template's own rendered output wins over a folder file of
// the same name. Wrapped links never resolve to a view unless the author also
// wrote that target: the author didn't ask for a snapshot of /feed.rss or
// /script.js, they just linked to it, so those are only looked up in the
// folder.
//
// A folder target's manifest entry is { path, version }: path is the file's
// real (case-corrected) path, version a hash of its content, from which
// blog/render/folderManifestUrl builds
// %%BLOT_CDN%%/folder/v-<version>/<blogID><path>, the URL entries use.
// Reserved global paths (/fonts, /katex, ...) are served from Blot's own
// static directory, have no version, and so no version in the entry. A view's
// entry stays a plain hash string, so existing manifests are valid as they are.
//
// A target whose file doesn't exist has no entry (the link is left as
// written) but is still a dependency of the template, so the file being
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

// The {{#cdn}} targets the template's authors wrote, from the views'
// retrieve.cdn: the ones which name a view, and the rest, which are folder
// files. extraFolderTargets are further targets which are only ever looked up
// in the folder, never as views (see the extraFolderTargets function below).
//
// setView carries a view's previous retrieve.cdn forward (see
// applyUserRetrieveOptions), so a target the author has since removed can
// linger there. That is harmless for a view target, but a folder target would
// keep a manifest entry and a file dependency forever, so folder targets only
// count while the view's current content still has them.
async function collectTargets(templateID, views, extraFolderTargets) {
  const explicit = new Set();
  const current = new Set();

  const addValid = (set, target) => {
    if (typeof target === "string" && target.trim() && isValidTarget(target.trim())) {
      set.add(target.trim());
    }
  };

  for (const viewName in views) {
    const view = views[viewName];

    if (view?.retrieve?.cdn && Array.isArray(view.retrieve.cdn)) {
      view.retrieve.cdn.forEach((target) => addValid(explicit, target));
    }

    if (typeof view?.content === "string") {
      const parsed = parseTemplate(view.content).retrieve || {};
      (parsed.cdn || []).forEach((target) => addValid(current, target));
    }
  }

  const viewTargets = [];
  const folderTargets = new Set(extraFolderTargets || []);

  for (const target of Array.from(explicit).sort()) {
    if (await viewExists(templateID, target)) {
      viewTargets.push(target);
      // the author's own target wins over the same one wrapped
      folderTargets.delete(target);
    } else if (current.has(target)) {
      folderTargets.add(target);
    }
  }

  return { viewTargets, folderTargets };
}

// A literal {{#asset}}/path{{/asset}} section (see blog/render/retrieve/asset)
const ASSET_SECTION = /\{\{#asset\}\}([^{}]+)\{\{\/asset\}\}/g;

// Every target which is only ever looked up in the folder, never as a view,
// gathered in one place:
//
// - the literal links getFullView and getPartials wrap in {{#cdn}} for each
//   view (wrapFolderLinks) and for the inline partials in package.json
//   (wrapInlinePartial): the same functions, on the same content, with the
//   same hosts, so the manifest and the render agree;
// - values which never pass through a view's text, so can't be wrapped:
//   template and view locals ("logo": "/images/logo.png", swapped for the CDN
//   URL at render time by blog/render/folderManifestUrl), and literal
//   {{#asset}} sections (blog/render/retrieve/asset).
function extraFolderTargets(metadata, views, hosts) {
  const targets = new Set();

  const add = (target) => {
    if (isValidTarget(target)) targets.add(target);
  };

  mapFolderLocals(metadata.locals, hosts, add);

  for (const viewName in views) {
    const view = views[viewName];
    if (!view) continue;

    wrapFolderLinks(view.content, {
      viewName: view.name || viewName,
      viewType: view.type,
      hosts,
    }).targets.forEach(add);

    mapFolderLocals(view.locals, hosts, add);

    if (typeof view.content === "string" && view.content.indexOf("{{#asset}}") > -1) {
      for (const match of view.content.matchAll(ASSET_SECTION)) {
        const value = match[1].trim();
        const target = folderTarget(
          value.charAt(0) === "/" ? value : "/" + value,
          []
        );

        if (target) add(target);
      }
    }

    for (const name in view.partials || {}) {
      const inline = view.partials[name];

      if (typeof inline === "string" && inline)
        wrapInlinePartial(inline, hosts).targets.forEach(add);
    }
  }

  return targets;
}

function normalizeDependency(filePath) {
  return pathNormalizer(filePath).toLowerCase();
}

// Looks up one target ("images/a.png?x=1") in the folder. Returns
// { requested, entry }: the path asked for (a dependency whether or not it
// exists) and its manifest entry, or null if there is no such file.
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

async function resolveFolderTargets(blogID, targets) {
  const blogFolder = path.join(config.blog_folder_dir, blogID);
  const entries = {};
  const dependencies = new Set();

  for (const target of targets) {
    try {
      const { requested, entry } = await resolveFolderCandidate(
        blogFolder,
        target
      );

      dependencies.add(normalizeDependency(requested));

      if (entry) entries[target] = entry;
    } catch (err) {
      console.error(`Error resolving folder target ${target}:`, err);
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

  // Stored with the manifest that references it, see updateCdnManifest below
  return {
    hash: computedHash,
    content: contentToWrite,
    name: path.basename(target),
  };
}

// Deletes a rendered output unless the template's saved manifest references
// it. One step, so a save that makes the hash current again (it writes the
// output and the manifest together) can't land between the check and the DEL.
const DELETE_IF_UNREFERENCED = `
if string.find(redis.call("HGET", KEYS[1], "cdn") or "", ARGV[1], 1, true) then return 0 end
return redis.call("DEL", KEYS[2], KEYS[3])`;

/**
 * Clean up old rendered output and purge CDN URL
 */
async function cleanupOldHash(templateID, target, oldHash) {
  if (!oldHash || typeof oldHash !== 'string') return;
  
  try {
    // A quick revert can make the old hash current again. Redis is the only
    // copy, so deleting it then would 404 the live file.
    const deleted = await client.eval(DELETE_IF_UNREFERENCED, {
      keys: [key.metadata(templateID), key.renderedOutput(oldHash), key.renderedOutputName(oldHash)],
      arguments: [oldHash],
    });

    if (!deleted) return;
    
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
          await cleanupOldHash(templateID, target, oldManifest[target]);
        }

        await updateDependencyIndex(
          templateID,
          metadata.owner,
          metadata.fileDependencies,
          []
        );

        return callback(null, {});
      }

      // Get all views and collect their CDN targets, including the literal
      // folder links the render wraps in {{#cdn}}, locals and {{#asset}}
      const views = await getAllViewsAsync(templateID);
      const { viewTargets: sortedTargets, folderTargets } =
        await collectTargets(
          templateID,
          views,
          extraFolderTargets(metadata, views, blogHosts(blog))
        );

      const manifest = {};
      const staleHashes = [];
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
        Array.from(folderTargets).sort()
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
          const output = await processTarget(
            templateID,
            target
          );
          const result = output && output.hash;
          if (result && typeof result === 'string') {
            const previousHash = inProgressManifest[target];
            inProgressManifest[target] = result;

            // Write the output and the manifest that references it together,
            // so a concurrent cleanup of this hash sees both or neither.
            // If storage fails, keep the target out of the manifest.
            try {
              await client
                .multi()
                .set(key.renderedOutput(result), output.content)
                .set(key.renderedOutputName(result), output.name)
                .hSet(key.metadata(templateID), "cdn", JSON.stringify(inProgressManifest))
                .exec();
            } catch (err) {
              if (previousHash === undefined) delete inProgressManifest[target];
              else inProgressManifest[target] = previousHash;
              throw err;
            }

            manifest[target] = result;

            // Clean up old hash if it changed
            const oldHash = oldManifest[target];
            if (oldHash && oldHash !== result && typeof oldHash === 'string') {
              // Cleaned up once the new manifest is saved, see below
              staleHashes.push([target, oldHash]);
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
        // Folder entries ({ path, version }) have no rendered output to
        // clean up; cleanupOldHash skips them
        if (typeof manifest[target] !== "string") {
          staleHashes.push([target, oldManifest[target]]);
        }
      }

      // Save manifest to Redis
      await hsetAsync(key.metadata(templateID), "cdn", JSON.stringify(manifest));

      // Run cleanup in background - don't await. It re-reads the saved
      // manifest so it must start after the save above.
      for (const [target, oldHash] of staleHashes) {
        cleanupOldHash(templateID, target, oldHash).catch(err => {
          // Error already logged in cleanupOldHash, but catch to prevent unhandled rejection
        });
      }
      
      callback(null, manifest);
    } catch (err) {
      callback(err);
    }
  })();
};

module.exports.cleanupOldHash = cleanupOldHash;
