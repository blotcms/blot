const config = require("config");
const express = require("express");
const cdn = new express.Router();
const mime = require("mime-types");

const client = require("models/client");
const key = require("models/template/key");
const path = require("path");

const GLOBAL_STATIC_FILES = config.blot_directory + "/app/blog/static";

const static = (path) =>
  express.static(path, {
    maxAge: "1y",
    fallthrough: false,
  });

// The health check
cdn.get("/health", (req, res) => {
  res.set("Cache-Control", "no-store");
  res.send("OK: " + new Date().toISOString());
});

// Simple CORS middleware
// This means we can server font files from the CDN
// and they will still work on customer sites
cdn.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  next();
});

// Global static files available to all blogs e.g.
// /fonts/agbalumo/400.woff2
// /plugins/katex/files/KaTeX_AMS-Regular.woff2
cdn.use("/fonts", static(GLOBAL_STATIC_FILES + "/fonts"));
cdn.use("/icons", static(GLOBAL_STATIC_FILES + "/icons"));
cdn.use("/katex", static(GLOBAL_STATIC_FILES + "/katex"));
cdn.use("/plugins", static(GLOBAL_STATIC_FILES + "/plugins"));

// Brochure and dashboard related static files, e.g.
// /documentation/v-8d7d9d72/favicon-180x180.png
// /documentation/v-76e1992c/documentation.min.css
cdn.use("/documentation/v-:version", static(config.views_directory));

// Serves files directly from a blog's folder e.g.
// /folder/blog_1234/favicon.ico
cdn.use("/folder/v-:version", static(config.blog_folder_dir));

// New route format: /template/{hash[0:2]}/{hash[2:4]}/{hash}{ext}
// Serves rendered output directly from disk using Express static middleware
// This route must come before the legacy route to match the new format first
// fallthrough: true allows requests to continue to legacy route if file not found
cdn.use("/template", express.static(path.join(config.data_directory, "cdn", "template"), {
  maxAge: "1y",
  immutable: true,
  fallthrough: true,
  setHeaders: (res) => {
    res.set("Cache-Control", "public, max-age=31536000, immutable");
  },
}));

// Legacy route format: /template/viewname.digest.extension (backward compatibility)
cdn.get("/template/:encodedViewAndHash(*)", async (req, res, next) => {
  try {
    // Parse URL format: viewname.digest.extension
    const parsed = parseCdnPath(req.params.encodedViewAndHash);
    if (!parsed) {
      return res.status(400).send("Invalid CDN path format");
    }

    const hash = parsed.hash;
    const viewName = parsed.viewName + parsed.extension;

    // Fetch rendered output directly by hash
    const renderedKey = key.renderedOutput(hash);
    const cachedOutput = await client.get(renderedKey);

    if (cachedOutput == null) {
      // Cache miss - return 404 (shouldn't happen if manifest is up to date)
      // Note: cachedOutput == null checks for both null and undefined,
      // but allows empty strings (which are valid cached values)
      console.warn('CDN cache miss for', viewName, hash);
      return next();
    }

    // Determine content type from view name
    const contentType = getContentType(viewName);
    
    // Set cache headers
    res.set("Cache-Control", "public, max-age=31536000, immutable");
    res.set("Content-Type", contentType);
    
    // Return cached output
    return res.send(cachedOutput);
  } catch (err) {
    return next();
  }
});

// Blog-specific static files, e.g.
// /blog_de64881e0dd94a5f8ba8f7aeaf807b86/_image_cache/739749f7-85eb-4b51-a6b9-c238b61c2c97.jpg
cdn.use(static(config.blog_static_files_dir));

module.exports = cdn;

/**
 * Get content type from view name
 */
function getContentType(viewName) {
  return mime.lookup(viewName) || 'text/plain';
}

/**
 * Parse CDN path format: viewname.digest.extension
 * Returns {viewName, hash, extension} or null if invalid
 */
function parseCdnPath(path) {
  if (!path) return null;

  try {
    // Decode and validate path segments
    const decoded = path
      .split("/")
      .map(function (part) {
        const decoded = decodeURIComponent(part);
        // Validate: no path traversal, no null bytes, reasonable length
        if (decoded.includes("..") || decoded.includes("\0") || decoded.length > 255) {
          throw new Error("Invalid path segment");
        }
        return decoded;
      })
      .join("/");

    // Extract hash (32 hex chars) and extension from the last segment
    const hashPattern = /\.([a-f0-9]{32})(\.[^/]+)?$/;
    const match = decoded.match(hashPattern);
    if (!match) return null;

    const hash = match[1];
    const extension = match[2] || "";
    const viewName = decoded.slice(0, match.index);

    // Final validation: no path traversal (already checked above, but double-check)
    if (viewName.includes("..") || viewName.includes("\0")) {
      return null;
    }

    return { viewName, hash, extension };
  } catch (err) {
    return null;
  }
}
