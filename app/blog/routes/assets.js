const assertNoSymlinks = require("helper/assertNoSymlinks");
const config = require("config");
const storage = require("storage/assets");
const express = require("express");
const contentTypeFor = require("storage/contentType");
const { join, basename, dirname, extname } = require("path");
const { promisify } = require("util");
const fs = require("fs-extra");
const caseSensitivePath = promisify(require("helper/caseSensitivePath"));
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
      !(await fs.pathExists(
        join(config.blog_folder_dir, req.blog.id, relPath)
      ))
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
  const blogFolder = config.blog_folder_dir + "/" + req.blog.id;
  const decodedPath = decodeURIComponent(req.path);

  async function sendFolderFile(path) {
    if (await redirectLargeFolderFile(req, res, blogFolder, path)) {
      logFolderAsset(req, "cdn-redirect");
      return;
    }
    await sendFile(path, { req, res });
    logFolderAsset(req, "origin");
  }

  try {
    await sendFolderFile(join(blogFolder, decodedPath));
    return;
  } catch (e) {}

  try {
    await sendFolderFile(join(blogFolder, decodedPath.toLowerCase()));
    return;
  } catch (e) {}

  try {
    const pathWithCorrectCase = await caseSensitivePath(
      blogFolder,
      decodedPath
    );

    const stat = await fs.stat(pathWithCorrectCase);

    if (!stat.isFile()) throw new Error("Not a file");

    await sendFolderFile(pathWithCorrectCase);
    return;
  } catch (e) {}

  try {
    await sendFolderFile(
      join(blogFolder, withoutTrailingSlash(decodedPath) + "/index.html")
    );
    return;
  } catch (e) {}

  try {
    await sendFolderFile(
      join(blogFolder, withoutTrailingSlash(decodedPath) + "/_index.html")
    );
    return;
  } catch (e) {}

  try {
    await sendFolderFile(
      join(blogFolder, withoutTrailingSlash(decodedPath) + ".html")
    );
    return;
  } catch (e) {}

  try {
    await sendFolderFile(
      join(blogFolder, addLeadingUnderscore(decodedPath) + ".html")
    );
    return;
  } catch (e) {}

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
async function redirectLargeFolderFile(req, res, blogFolder, path) {
  if (!path.startsWith(blogFolder + "/")) return false;

  // Only the part the CDN URL exposes, so dot directories above the blog
  // folder (e.g. in the data directory's own path) don't matter.
  const relPath = path.slice(blogFolder.length);
  if (!canRedirectToCdn(req, relPath)) return false;

  await assertNoSymlinks(blogFolder, path);
  const stat = await fs.stat(path);

  if (!stat.isFile() || stat.size < CDN_REDIRECT_MIN_SIZE) return false;

  redirectToCdn(
    req,
    res,
    "/folder/" + versionedFolderPath(req.blog.id, relPath, stat)
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

async function sendFile(path, { req, res, maxAge = 0, immutable = false } = {}) {
  // Static app assets also use this function; only blog-folder paths need
  // the blog's no-symlink policy, including every ancestor within that root.
  const blogRoot = req?.blog && join(config.blog_folder_dir, req.blog.id);
  if (blogRoot && (path === blogRoot || path.startsWith(blogRoot + "/"))) {
    await assertNoSymlinks(blogRoot, path);
  }
  const options = {
    maxAge,
    immutable,
    dotfiles: "allow",
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

  return new Promise((resolve, reject) => {
    res.sendFile(path, options, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

module.exports = assets;
