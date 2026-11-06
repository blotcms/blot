const config = require("config");
const path = require("path");

/**
 * Generate a CDN URL for a template view
 * @param {string} viewName - The view name (e.g., "style.css" or "partials/header.html")
 * @param {string} hash - The hash for the view content
 * @returns {string} The CDN URL in format: /template/{hash[0:2]}/{hash[2:4]}/{hash[4:]}/{basename}
 */
function generateCdnUrl(viewName, hash) {
  if (!viewName || typeof viewName !== "string") {
    throw new Error("viewName must be a non-empty string");
  }

  if (!hash || typeof hash !== "string" || hash.length < 4) {
    throw new Error("hash must be a non-empty string with at least 4 characters");
  }

  // URL format: /template/{hash[0:2]}/{hash[2:4]}/{hash[4:]}/{basename}
  // First 4 chars of hash are used in parent directories, remaining chars in third directory
  // Files are stored with basename only, so URL must match (use path.basename)
  // Encode the basename to handle special characters (%, #, ?, spaces, etc.)
  const dir1 = hash.substring(0, 2);
  const dir2 = hash.substring(2, 4);
  const hashRemainder = hash.substring(4);
  const viewBaseName = path.basename(viewName);
  const encodedBaseName = encodeURIComponent(viewBaseName);
  return config.cdn.origin + "/template/" + dir1 + "/" + dir2 + "/" + hashRemainder + "/" + encodedBaseName;
}

module.exports = generateCdnUrl;

