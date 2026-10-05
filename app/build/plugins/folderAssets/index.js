const config = require("config");
const fs = require("fs-extra");
const async = require("async");
const cheerio = require("cheerio");
const { join, resolve, posix } = require("path");
const { promisify } = require("util");
const contentVersion = require("helper/contentVersion");
const caseSensitivePath = promisify(require("helper/caseSensitivePath"));
const BLOT_CDN_TOKEN = require("blog/render/replaceFolderLinks/cdnToken");
const unwrapFolderLink = require("blog/render/replaceFolderLinks/unwrapFolderLink");
const {
  GLOBAL_STATIC_DIR,
  isReservedStaticPath,
} = require("blog/lib/staticPaths");
const blogHosts = require("blog/lib/blogHosts");
const {
  htmlExtRegex,
  fileExtRegex,
  parseSrcset,
} = require("blog/render/replaceFolderLinks/shared");

const ATTRS = ["href", "src", "poster"];

// Bounds concurrent file reads/hashes for one entry (a gallery post can
// reference dozens of files).
const HASH_CONCURRENCY = 8;

// An entry belongs to exactly one blog forever, so - unlike template CSS/JS,
// which can be rendered by many different blogs - a relative link inside an
// entry's content can be resolved to a versioned CDN URL once, at build
// time, instead of on every request. This plugin runs at the end of the
// render-stage plugin list (app/build/plugins/index.js), after everything
// that could itself introduce a new folder-relative link (e.g. autoImage),
// and rewrites href/src/poster/srcset attributes that
// app/build/dependencies/index.js has already resolved to absolute paths
// inside the blog's own folder. The result is baked with the %%BLOT_CDN%%
// token (see cdnToken.js) rather than the real CDN origin, which
// middleware.js resolves unconditionally on every response.
//
// The baked version is frozen into entry.html, so every file baked here is
// returned as a new dependency: entry.dependencies is diffed into a Redis
// reverse index by app/models/entry/_rebuildDependencyGraph.js, and
// app/sync/update/rebuildDependents.js rebuilds (and so re-bakes) any entry
// that depends on a file whenever it changes, is renamed, or is deleted.
// app/build/dependencies/index.js only records href/src, so poster and
// srcset (and links spliced in from another entry's already-baked HTML by
// the wikilinks plugin) would otherwise never invalidate.
//
// Front matter can replace derived markup fields outright (body, teaser,
// teaserBody - see build/prepare). That happens after the plugins have run,
// so build/index.js bakes those fields separately with bakeHTML below and
// merges the dependencies it returns.
//
// Note that baked links can exist before this plugin runs: wikilinks is
// first, and splices other entries' stored (already baked) HTML into the
// post, so every plugin in between can see %%BLOT_CDN%% URLs.
//
// Links that are already baked for this blog are unwrapped and re-baked
// rather than skipped, so a copy of another entry's HTML (wikilink embeds)
// gets a fresh version instead of the embedded entry's stale one.
function render($, callback, options) {
  bake($, options).then(
    ({ dependencies }) => callback(null, { newDependencies: dependencies }),
    callback
  );
}

// Bakes an HTML string, for markup which doesn't go through the plugin
// pipeline (front matter overrides). options are the same as render's:
// { blogID, handle, domain, path }. Returns { html, dependencies }; html is
// the input, untouched, if there was nothing to bake.
async function bakeHTML(html, options) {
  const $ = cheerio.load(html, { decodeEntities: false }, false);
  const { dependencies, changed } = await bake($, options);

  return { html: changed ? $.html() : html, dependencies };
}

function bake($, options) {
  const blogID = options.blogID;
  const blogFolder = join(config.blog_folder_dir, blogID);
  const dependencies = new Set();
  // Absolute URLs on one of the blog's own hosts (https://blog.example.com/
  // photo.jpg) are baked like relative links; see stripOwnHost.
  const hostPatterns = blogHosts({
    handle: options.handle,
    domain: options.domain,
  }).map((host) => new RegExp(`^(?:https?:)?//${escapeRegex(host)}(?=[/?#]|$)`, "i"));
  // Resolved path -> Promise<{ path, version }>, so a file referenced
  // several times in one entry (src and srcset) is only read and hashed once.
  const ctx = {
    blogID,
    blogFolder,
    dependencies,
    hostPatterns,
    entryPath: options.path,
    files: new Map(),
    globalFiles: new Map(),
    changed: false,
  };
  const tasks = [];

  $("[href], [src], [poster], [srcset]").each(function () {
    const $el = $(this);

    ATTRS.forEach((attr) => {
      const value = $el.attr(attr);

      if (!value || typeof value !== "string") return;

      tasks.push(() =>
        bakeValue(ctx, value, attr === "poster").then((result) => {
          if (result === null) return;
          $el.attr(attr, result);
          ctx.changed = true;
        })
      );
    });

    const srcset = $el.attr("srcset");

    if (srcset) {
      tasks.push(() =>
        rewriteSrcset(ctx, srcset).then((rebuilt) => {
          if (rebuilt === null) return;
          $el.attr("srcset", rebuilt);
          ctx.changed = true;
        })
      );
    }
  });

  return new Promise((resolve, reject) => {
    async.eachLimit(
      tasks,
      HASH_CONCURRENCY,
      (task, next) => task().then(() => next(), next),
      (err) => {
        if (err) return reject(err);
        resolve({ dependencies: Array.from(dependencies), changed: ctx.changed });
      }
    );
  });
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Same-host absolute URLs are baked at build time too, so nothing about them
// is left for request-time replaceFolderLinks (html.js/css.js) to do. The
// host is stripped exactly as html.js does at request time, leaving a path
// that is then treated like any other folder-relative link. Returns the
// value unchanged if it isn't on one of the blog's hosts.
function stripOwnHost(ctx, value) {
  for (const pattern of ctx.hostPatterns) {
    if (pattern.test(value)) return value.replace(pattern, "") || "/";
  }
  return value;
}

function resolveAgainstEntry(ctx, value) {
  if (!ctx.entryPath || !value) return value;
  // absolute paths, URLs (any scheme or //host), fragments and queries
  if (/^([a-z][a-z0-9+.-]*:|\/|#|\?)/i.test(value)) return value;
  if (value.indexOf(BLOT_CDN_TOKEN) > -1) return value;

  const cutIndex = value.search(/[#?]/);
  const pathPart = cutIndex === -1 ? value : value.slice(0, cutIndex);
  const suffix = cutIndex === -1 ? "" : value.slice(cutIndex);

  if (!pathPart) return value;

  return posix.resolve(posix.dirname(ctx.entryPath), pathPart) + suffix;
}

function pathPartOf(value) {
  const cutIndex = value.search(/[#?]/);
  return cutIndex === -1 ? value : value.slice(0, cutIndex);
}

function isEligible(value) {
  if (!value || typeof value !== "string") return false;
  if (value.indexOf("://") > -1) return false;
  if (value.startsWith("data:")) return false;
  if (value.indexOf(BLOT_CDN_TOKEN) > -1) return false;
  if (value.charAt(0) !== "/") return false;

  const pathPart = pathPartOf(value);

  // Reserved global-static prefixes (/fonts, /icons...) stay eligible: they
  // are baked from the global static directory when the file is there, see
  // globalStaticFileExists.

  if (htmlExtRegex.test(pathPart)) return false;
  if (!fileExtRegex.test(pathPart)) return false;

  return true;
}

// Returns the new attribute value, or null to leave it untouched.
//
// poster and srcset aren't normalized by app/build/dependencies/index.js
// (it only walks href/src), so with resolveRelative set, a value that is
// relative to the entry (poster="movie.jpg") is first resolved against the
// entry's own path.
async function bakeValue(ctx, value, resolveRelative) {
  if (resolveRelative) value = resolveAgainstEntry(ctx, value);

  const unwrapped = unwrapFolderLink(value, ctx.blogID);
  const wasBaked = unwrapped !== null;
  const raw = wasBaked ? unwrapped : stripOwnHost(ctx, value);

  if (!isEligible(raw)) return null;

  const result = await resolveBuildFile(ctx, raw, wasBaked);

  if (result) {
    if (result.path) addDependency(ctx, result.path);
    return result.url;
  }

  // No file behind the link (or the file behind an already-baked link is
  // gone). Still record the dependency so the entry is rebuilt, and baked,
  // if the file (re)appears - regardless of whether another entry's HTML
  // we embedded had already dropped back to the plain path. Where the link
  // was baked, drop back to the plain path so request-time resolution
  // decides instead of keeping a URL for a now-missing versioned file.
  //
  // The path is decoded the way resolveBuildFile decodes it (unless it came
  // from a baked link, which already holds the real path), because the file
  // which arrives is "/my pic.jpg" and not "/my%20pic.jpg".
  addDependency(
    ctx,
    wasBaked ? pathPartOf(raw) : decodeIfEncoded(pathPartOf(raw))
  );

  return wasBaked ? raw : null;
}

// An entry is always rebuilt when its own file changes, and (like
// app/build/dependencies/index.js) shouldn't be recorded as a dependent of
// itself - e.g. an image-as-entry pointing at its own file. The URL is still
// baked; only the graph edge is skipped.
function addDependency(ctx, path) {
  if (ctx.entryPath && path.toLowerCase() === ctx.entryPath.toLowerCase()) {
    return;
  }

  ctx.dependencies.add(path);
}

// e.g. '100% luck.jpg' throws a URIError - the value is left unchanged then.
function decodeIfEncoded(value) {
  if (!value.includes("%")) return value;

  try {
    return decodeURIComponent(value);
  } catch (err) {
    return value;
  }
}

async function rewriteSrcset(ctx, value) {
  const candidates = parseSrcset(value);
  if (!candidates) return null;

  let changed = false;

  // Sequential, so one srcset holds at most one file open and the outer
  // HASH_CONCURRENCY bound on attribute tasks is a real bound.
  const rebuilt = [];

  for (const candidate of candidates) {
    const result = await bakeValue(ctx, candidate.url, true);
    const url = result === null ? candidate.url : result;

    if (result !== null) changed = true;

    rebuilt.push(candidate.descriptor ? `${url} ${candidate.descriptor}` : url);
  }

  return changed ? rebuilt.join(", ") : null;
}

// Resolves a folder-relative attribute value (already an absolute path
// inside the blog's folder, per app/build/dependencies/index.js) into a
// %%BLOT_CDN%%-prefixed, versioned URL. Returns { url, path } (path being
// the case-corrected file path, for recording as a dependency), or null
// (ENOENT) if there's no matching file - mirroring
// app/blog/render/replaceFolderLinks/lookupFile.js's "leave untouched"
// behavior. alreadyDecoded is set for paths recovered from an
// already-baked link, which hold the real (unencoded) file path.
async function resolveBuildFile(ctx, value, alreadyDecoded) {
  const { blogID, blogFolder } = ctx;
  const hashIndex = value.indexOf("#");
  const hash_ = hashIndex > -1 ? value.slice(hashIndex) : "";
  value = hashIndex > -1 ? value.slice(0, hashIndex) : value;

  if (!alreadyDecoded) value = decodeIfEncoded(value);

  const [pathFromValue, ...rest] = value.split("?");
  const query = rest.length ? `?${rest.join("?")}` : "";

  // Checked after percent-decoding (e.g. /f%6Fnts). Mirrors lookupFile.js: a
  // file in the global static directory wins, otherwise the path is looked
  // up in the blog's folder like any other.
  if (
    isReservedStaticPath(pathFromValue) &&
    (await globalStaticFileExists(ctx, pathFromValue))
  ) {
    return {
      url: `${BLOT_CDN_TOKEN}${value}${hash_}`,
      // Not a file in the blog's folder, so there is nothing to depend on.
      path: null,
    };
  }

  const cacheKey = resolve("/", pathFromValue);

  if (!ctx.files.has(cacheKey)) {
    ctx.files.set(cacheKey, hashFolderFile(blogFolder, cacheKey));
  }

  const file = await ctx.files.get(cacheKey);

  if (!file) return null;

  const { path: resolvedPath, version } = file;

  return {
    url: `${BLOT_CDN_TOKEN}/folder/v-${version}/${blogID}${resolvedPath}${query}${hash_}`,
    path: resolvedPath,
  };
}

// Whether a reserved path (/fonts/...) is a file in Blot's global static
// directory. A path which only looks reserved until it is normalized
// (/fonts/../x) never counts, so it can't reach outside the directory.
function globalStaticFileExists(ctx, path) {
  const normalized = posix.normalize(path);

  if (!isReservedStaticPath(normalized)) return Promise.resolve(false);

  if (!ctx.globalFiles.has(normalized)) {
    ctx.globalFiles.set(
      normalized,
      fs.stat(join(GLOBAL_STATIC_DIR, normalized)).then(
        (stat) => stat.isFile(),
        () => false
      )
    );
  }

  return ctx.globalFiles.get(normalized);
}

// Returns { path, version } for a file in the blog folder, or null if it
// doesn't exist. path is the case-corrected path.
//
// The version token is a hash of the file's content (helper/contentVersion),
// not its mtime/ctime: blog folders are moving from local disk to S3, which
// can't set a file's Last-Modified and has no ctime, but does hand back a
// content-derived ETag for free on every PUT. Until storage reads switch
// over, local disk pays the cost of hashing on each build (contentVersion
// falls back to a size+mtime token above its size cap instead).
async function hashFolderFile(blogFolder, path) {
  let stat, resolvedPath;

  try {
    ({ stat, path: resolvedPath } = await getStat(blogFolder, path));
  } catch (err) {
    return null;
  }

  return {
    path: resolvedPath,
    version: await contentVersion(join(blogFolder, resolvedPath), stat),
  };
}

async function getStat(blogFolder, path) {
  const filePath = join(blogFolder, path);

  try {
    const stat = await fs.stat(filePath);
    return { stat, path };
  } catch (e) {}

  const resolvedPath = await caseSensitivePath(blogFolder, path);
  const resolvedRelativePath = resolvedPath.slice(blogFolder.length);
  const stat = await fs.stat(resolvedPath);
  return { stat, path: resolvedRelativePath };
}

module.exports = {
  render,
  bakeHTML,
  // Internal build optimization, not a user setting: always runs, and is
  // hidden from the plugins page (see dashboard/site/load/plugins.js).
  optional: false,
  category: "assets",
  title: "Folder assets",
  description:
    "Bake relative links to files in the blog's folder into versioned CDN URLs at build time",
};
