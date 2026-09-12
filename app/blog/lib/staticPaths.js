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

module.exports = {
  GLOBAL_STATIC_DIR: config.blot_directory + "/app/blog/static",
  GLOBAL_STATIC_SUBDIRECTORIES,
};
