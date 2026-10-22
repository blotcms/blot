const config = require("config");

// Global static assets directory shared by the assets router and
// CDN folder-link rewriting. Keep this single source of truth so both
// stay aligned with helper/transformer/ownHost's reserved prefixes.
const GLOBAL_STATIC_SUBDIRECTORIES = [
  "/fonts",
  "/icons",
  "/katex",
  "/plugins",
  "/syntax-highlighter",
];

// Per-blog generated assets (image cache, thumbnails, ...), stored by
// app/storage rather than in the blog's folder.
const BLOG_STATIC_PATHS = [
  "/_assets",
  "/_avatars",
  "/_bookmark_screenshots",
  "/_image_cache",
  "/_thumbnails",
];

// True for "/fonts" or anything under "/fonts/", but not "/fontsFoo".
function isReservedStaticPath(path) {
  return GLOBAL_STATIC_SUBDIRECTORIES.some(
    (dir) => path === dir || path.startsWith(dir + "/")
  );
}

module.exports = {
  isReservedStaticPath,
  GLOBAL_STATIC_DIR: config.blot_directory + "/app/blog/static",
  GLOBAL_STATIC_SUBDIRECTORIES,
  BLOG_STATIC_PATHS,
};
