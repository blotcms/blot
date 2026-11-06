const storage = require("storage/assets");
const folder = require("storage/folder");
const express = require("express");
const contentTypeFor = require("storage/contentType");
const { join, basename, dirname, extname, normalize } = require("path");
const caseSensitivePath = require("helper/caseSensitivePath");
const {
  GLOBAL_STATIC_DIR,
  GLOBAL_STATIC_SUBDIRECTORIES,
  BLOG_STATIC_PATHS,
} = require("../lib/staticPaths");
const blogHosts = require("../lib/blogHosts");
const cdnOrigin = require("../lib/cdnOrigin");
const {
  htmlExtRegex,
  fileExtRegex,
  encodeFolderPath,
  versionedFolderPath,
} = require("../render/replaceFolderLinks/shared");

// Constants
const LARGEST_POSSIBLE_MAXAGE = 86400000;

// Folder files at least this big are redirected to the CDN instead of being
// served from the app host, to keep large transfers off its bandwidth.
const CDN_REDIRECT_MIN_SIZE = 256 * 1024;

// Only types which are safe to serve from the CDN origin: never svg, html,
// css, js, json, fonts or text, which a page could load same-origin or
// which could run script there.
const CDN_REDIRECT_EXTENSIONS = new Set(
  (
    "jpg jpeg png gif webp avif heic heif tif tiff bmp " +
    "mp3 m4a wav ogg oga opus flac aac " +
    "mp4 m4v mov webm mkv avi ogv " +
    "pdf epub zip gz tgz tar rar 7z dmg doc docx ppt pptx xls xlsx odt"
  ).split(" ")
);

// We always return 404 for requests which contain these patterns
const BLOCKED_PATTERNS = [
  "..", // parent directory traversal
  ".php", // blot does not support PHP
  "/.git", // avoid exposing git directories
  "\0", // null byte
];

// Router setup
const assets = express.Router();

// Security middleware
assets.use((req, res, next) => {
  if (
    BLOCKED_PATTERNS.some(
      (pattern) =>
        req.path.includes(pattern) ||
        decodeURIComponent(req.path).includes(pattern)
    )
  ) {
    return next(new Error("Not Found"));
  }
  next();
});

// Global static files
GLOBAL_STATIC_SUBDIRECTORIES.forEach((dir) => {
  assets.use(
    dir,
    express.static(GLOBAL_STATIC_DIR + dir, {
      maxAge: "1y",
      // only called when a static file is actually sent
      setHeaders: (res) => logFolderAsset(res.req, "static"),
    })
  );
});

assets.get("/html2canvas.min.js", async (req, res, next) => {
  try {
    await sendFile(GLOBAL_STATIC_DIR + "/html2canvas.min.js", {
      req,
      res,
      maxAge: LARGEST_POSSIBLE_MAXAGE,
      immutable: true,
    });
  } catch (err) {
    next();
  }
});

assets.get("/layout.css", async (req, res, next) => {
  try {
    await sendFile(GLOBAL_STATIC_DIR + "/layout.css", {
      req,
      res,
      maxAge: LARGEST_POSSIBLE_MAXAGE,
      immutable: true,
    });
  } catch (err) {
    next();
  }
});

// Blog-specific static assets
assets.use(BLOG_STATIC_PATHS, async (req, res, next) => {
  try {
    const relPath = req.baseUrl + decodeURIComponent(req.path);

    // These names are unique and immutable, and the CDN reads the same
    // bucket key ({blogID}/{relPath}), so there is no need to check the
    // bucket first. A same-named file in the blog folder keeps the old
    // bucket-then-folder lookup instead, since the bucket may not have it.
    if (
      canRedirectToCdn(req, relPath) &&
      !(await folder.exists(req.blog.id, relPath))
    ) {
      return redirectToCdn(
        req,
        res,
        `/${req.blog.id}${encodeFolderPath(relPath)}`
      );
    }

    await storage.serve(req, res, req.blog.id, relPath, {
      maxAge: LARGEST_POSSIBLE_MAXAGE,
      immutable: true,
      headers: { "Content-Type": contentTypeFor(relPath) },
    });
  } catch (err) {
    next();
  }
});

// Try to serve files from the blog folder
assets.use(async (req, res, next) => {
  const blogID = req.blog.id;
  const decodedPath = decodeURIComponent(req.path);

  async function sendFolderFile(path) {
    if (await redirectLargeFolderFile(req, res, path)) {
      logFolderAsset(req, "cdn-redirect");
      return;
    }
    await sendBlogFile(path, { req, res });
    logFolderAsset(req, "origin");
  }

  // Resolves true once a response has been started for this path. A failure
  // before any header is sent just means this candidate doesn't work.
  async function trySend(path) {
    try {
      await sendFolderFile(path);
      return true;
    } catch (e) {
      return res.headersSent;
    }
  }

  // The exact path is by far the commonest hit, so it costs no directory read
  const exactPath = normalize(decodedPath);
  if (await trySend(exactPath)) return;

  // Every other candidate is resolved from directory listings, each read at
  // most once, rather than by probing the folder once per
  // candidate. Listings leave out symlinks, so none is ever a candidate, and
  // whatever we do send still goes through storage/folder's symlink check.
  const listings = new Map();
  const list = (dir) => {
    if (!listings.has(dir))
      listings.set(
        dir,
        folder.listNames(blogID, dir).catch(() => null)
      );
    return listings.get(dir);
  };

  // Chooses the entry of dir which segment refers to, per pick, and says
  // whether it is a directory: { path, isDirectory } or undefined
  async function lookup(dir, segment, pick) {
    const entries = await list(dir);
    if (!entries) return;
    const name = pick(
      entries.map((entry) => entry.name),
      segment
    );
    if (name === undefined) return;
    const entry = entries.find((e) => e.name === name);
    return { path: join(dir, name), isDirectory: entry.isDirectory };
  }

  // Walks down through the directories named by segments, choosing each with
  // pick. Resolves { dir } on success, { missing: true } when nothing matches
  // a segment (so nothing can exist below it) and {} when a match isn't a
  // directory.
  async function walk(segments, pick) {
    let dir = "/";
    for (const segment of segments) {
      const found = await lookup(dir, segment, pick);
      if (!found) return { missing: true };
      if (!found.isDirectory) return {};
      dir = found.path;
    }
    return { dir };
  }

  // Finds a file at exactly this path in the blog folder. A trailing
  // slash means the directory's index.html, as it does for the exact path.
  async function findExact(relative) {
    relative = normalize("/" + relative);
    if (relative.endsWith("/")) relative += "index.html";
    const segments = relative.split("/").filter(Boolean);
    const name = segments.pop();
    const { dir } = await walk(segments, exact);
    return name && dir && (await fileIn(dir, name, exact));
  }

  async function fileIn(dir, segment, pick) {
    const found = await lookup(dir, segment, pick);
    if (found && !found.isDirectory) return found.path;
  }

  const exact = (names, name) => (names.includes(name) ? name : undefined);
  const caseInsensitive = caseSensitivePath.pick;
  const segments = normalize(decodedPath).split("/").filter(Boolean);
  let parent;
  try {
    parent = await walk(segments.slice(0, -1), caseInsensitive);
  } catch (e) {
    parent = {};
  }

  const candidates = [
    // the whole path lowercased
    () => findExact(decodedPath.toLowerCase()),
    // the path with the casing it has on disk, if that's a file
    () =>
      segments.length &&
      parent.dir &&
      fileIn(parent.dir, segments[segments.length - 1], caseInsensitive),
    () => findExact(withoutTrailingSlash(decodedPath) + "/index.html"),
    () => findExact(withoutTrailingSlash(decodedPath) + "/_index.html"),
    () => findExact(withoutTrailingSlash(decodedPath) + ".html"),
    () => findExact(addLeadingUnderscore(decodedPath) + ".html"),
  ];

  const tried = new Set([exactPath]);

  // Without the parent directory under any casing, only the lowercased path
  // can still exist (the walk prefers exact names, so it follows every other
  // candidate if they exist): this is where a scanner's request usually ends
  for (const candidate of parent.missing
    ? candidates.slice(0, 1)
    : candidates) {
    let path;
    try {
      path = await candidate();
    } catch (e) {
      // e.g. a name which isn't valid percent-encoding when decoded again
      continue;
    }
    if (!path || tried.has(path)) continue;
    tried.add(path);
    if (await trySend(path)) return;
  }

  // If we get here, none of the candidates worked
  if (!res.headersSent) {
    next();
  }
});

// Error handling
assets.use((err, req, res, next) => {
  if (err && err.message === "Not Found") {
    return next();
  }
  next(err);
});

// Logs every file served here from the blog folder, or from Blot's global
// static directory, with how it was served and the page that linked to it.
// The folder-link rewrite only covers the links it finds, so this is how we
// see which ones still reach the origin: a template or entry that wasn't
// baked, a link built from a variable, a relative link. Pages (the .html
// fallbacks above, extensionless paths) are skipped: navigating between them
// is expected, and the folder-link passes never rewrite them either.
//
//   [folder-asset] blog=<id> handle=<h> served=origin|cdn-redirect|static
//     path=<path> referer=<host><path>|-|invalid same_site=1|0
function logFolderAsset(req, served) {
  try {
    // Template editor previews never use CDN URLs, so their hits say nothing
    if (req.preview) return;

    const originalPath = req.originalUrl.split("?")[0];
    const path = decodeURIComponent(originalPath);
    if (htmlExtRegex.test(path) || !fileExtRegex.test(path)) return;

    let referer = "-";
    let sameSite = 0;
    const header = req.get("referer");

    if (header) {
      try {
        const url = new URL(header);
        const host = url.hostname.toLowerCase();
        // pathname is already percent-encoded
        referer = host + url.pathname;
        sameSite = blogHosts(req.blog).includes(host) ? 1 : 0;
      } catch (e) {
        referer = "invalid";
      }
    }

    req.log(
      "[folder-asset]",
      `blog=${req.blog.id}`,
      `handle=${req.blog.handle}`,
      `served=${served}`,
      `path=${encodeURI(path)}`,
      `referer=${referer}`,
      `same_site=${sameSite}`
    );
  } catch (e) {
    // logging must not affect the response
  }
}

function canRedirectToCdn(req, path) {
  return (
    !req.preview &&
    (req.method === "GET" || req.method === "HEAD") &&
    // the CDN's express.static ignores dotfiles, so it would 404 these
    !path.split("/").some((segment) => segment.startsWith(".")) &&
    CDN_REDIRECT_EXTENSIONS.has(extname(path).slice(1).toLowerCase())
  );
}

// no-cache for browsers, which should re-check; the proxy caches the 302
// regardless, and is purged for the whole host whenever the folder changes.
function redirectToCdn(req, res, cdnPath) {
  res.set("Cache-Control", "no-cache");
  res.redirect(302, cdnOrigin(req) + cdnPath);
}

// Sends a 302 to the CDN for a large file of a safe type, with a
// size+mtime version in the URL. Resolves false when the file should be
// served here.
async function redirectLargeFolderFile(req, res, path) {
  // A trailing slash names a directory's index.html, never a file to redirect
  if (path.endsWith("/") || !canRedirectToCdn(req, path)) return false;

  const stat = await folder.stat(req.blog.id, path);

  if (stat.isDirectory || stat.size < CDN_REDIRECT_MIN_SIZE) return false;

  redirectToCdn(
    req,
    res,
    "/folder/" + versionedFolderPath(req.blog.id, path, stat)
  );
  return true;
}

function withoutTrailingSlash(path) {
  return path && path.slice(-1) === "/" ? path.slice(0, -1) : path;
}

function addLeadingUnderscore(path) {
  path = withoutTrailingSlash(decodeURIComponent(path));
  return join(dirname(path), "_" + basename(path));
}

// The headers and caching for a file: no-cache unless it has a maxAge or is
// asked to be cached with ?cache and ?extension
function sendOptions(path, { req, maxAge = 0, immutable = false } = {}) {
  const options = {
    maxAge,
    immutable,
    headers: {
      "Content-Type": contentTypeFor(path),
    },
  };

  if (!maxAge && req && !req.query.cache && !req.query.extension) {
    options.headers["Cache-Control"] = "no-cache";
  }

  if (req && req.query.cache && req.query.extension) {
    options.maxAge = LARGEST_POSSIBLE_MAXAGE;
  }

  return options;
}

// Sends one of Blot's own static files
function sendFile(path, { req, res, maxAge, immutable } = {}) {
  const options = sendOptions(path, { req, maxAge, immutable });
  options.dotfiles = "allow";

  return new Promise((resolve, reject) => {
    res.sendFile(path, options, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

// Sends a file from the blog's folder, which refuses symlinks and allows
// dotfiles. A trailing slash makes it serve the directory's index.html.
function sendBlogFile(path, { req, res }) {
  return folder.serve(req, res, req.blog.id, path, sendOptions(path, { req }));
}

module.exports = assets;
