const assertNoSymlinks = require("helper/assertNoSymlinks");
const config = require("config");
const express = require("express");
const mime = require("mime-types");
const { join, basename, dirname } = require("path");
const { promisify } = require("util");
const fs = require("fs-extra");
const caseSensitivePath = promisify(require("helper/caseSensitivePath"));
const {
  GLOBAL_STATIC_DIR,
  GLOBAL_STATIC_SUBDIRECTORIES,
} = require("../lib/staticPaths");
const blogHosts = require("../lib/blogHosts");
const {
  htmlExtRegex,
  fileExtRegex,
} = require("../render/replaceFolderLinks/shared");

// Constants
const LARGEST_POSSIBLE_MAXAGE = 86400000;

// We always return 404 for requests which contain these patterns
const BLOCKED_PATTERNS = [
  "..", // parent directory traversal
  ".php", // blot does not support PHP
  "/.git", // avoid exposing git directories
  "\0", // null byte
];

const BLOG_STATIC_PATHS = [
  "/_assets",
  "/_avatars",
  "/_bookmark_screenshots",
  "/_image_cache",
  "/_thumbnails",
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
  assets.use(dir, express.static(GLOBAL_STATIC_DIR + dir, { maxAge: "1y" }));
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
    const filePath =
      config.blog_static_files_dir + "/" + req.blog.id + req.baseUrl + decodeURIComponent(req.path);
    await sendFile(filePath, {
      req,
      res,
      maxAge: LARGEST_POSSIBLE_MAXAGE,
      immutable: true,
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
    await sendFile(path, { req, res });
    logSameSiteReferer(req);
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

// A blog-folder file was fetched from one of the blog's own pages, i.e. a
// link there points at the origin instead of the CDN. Only logged so we can
// find out where such links still come from. Pages (the .html fallbacks
// above, extensionless paths) are skipped: navigating between them is
// expected, and the folder-link passes never rewrite them either.
function logSameSiteReferer(req) {
  try {
    const path = decodeURIComponent(req.path);
    if (htmlExtRegex.test(path) || !fileExtRegex.test(path)) return;

    const referer = req.get("referer");
    if (!referer) return;

    const url = new URL(referer);
    if (!blogHosts(req.blog).includes(url.hostname.toLowerCase())) return;

    req.log(
      "[folder-asset-origin]",
      `blog=${req.blog.id}`,
      `handle=${req.blog.handle}`,
      `path=${encodeURI(req.originalUrl.split("?")[0])}`,
      `referer_path=${encodeURI(url.pathname)}`
    );
  } catch (e) {
    // an unparseable Referer must not affect the response
  }
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
  const isDirectory = path.indexOf(".") === -1;
  const defaultMime = isDirectory ? "text/html" : "application/octet-stream";
  let contentType = mime.contentType(mime.lookup(path) || defaultMime);

  if (contentType === "application/mp4") {
    contentType = "video/mp4";
  }

  const options = {
    maxAge,
    immutable,
    dotfiles: "allow",
    headers: {
      "Content-Type": contentType,
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
