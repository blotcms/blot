const assertNoSymlinks = require("helper/assertNoSymlinks");
const fs = require("fs").promises;
const config = require("config");
const express = require("express");
const cdn = new express.Router();
const mime = require("mime-types");

const client = require("models/client");
const { isRedisUnavailableError } = require("helper/redisUnavailable");
const key = require("models/template/key");
const path = require("path");
const assets = require("storage/assets");

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
cdn.use("/folder/v-:version", async (req, res, next) => {
  try {
    const filename = path.join(config.blog_folder_dir, decodeURIComponent(req.path));
    await assertNoSymlinks(config.blog_folder_dir, filename);
    // express.static also serves index.html for directory requests.
    const stat = await fs.stat(filename);
    if (stat.isDirectory()) {
      await assertNoSymlinks(config.blog_folder_dir, path.join(filename, "index.html"));
    }
    next();
  } catch (err) {
    // Never expose filesystem paths or distinguish forbidden links from a
    // missing asset. Do not fall through to another static root.
    res.sendStatus(404);
  }
}, static(config.blog_folder_dir));

// Template output from the {{#cdn}} helper, stored in Redis by hash, e.g.
// /template/{hash[0:2]}/{hash[2:4]}/{hash[4:]}/{basename}
// A miss is a 404 and must not fall through to the blog asset handler below.
cdn.get("/template/:d1/:d2/:rest/:name", async (req, res, next) => {
  const { d1, d2, rest, name } = req.params;

  if (!/^[a-f0-9]{2}$/.test(d1) || !/^[a-f0-9]{2}$/.test(d2) || !/^[a-f0-9]{28}$/.test(rest)) {
    return res.sendStatus(404);
  }

  // The name only picks the Content-Type, but a view basename never holds these
  if (/[\/\\\0]/.test(name) || name.startsWith("..")) return res.sendStatus(404);

  // We never publish source maps; devtools request them and would otherwise
  // get the asset itself with a 200 that Bunny caches for a year
  if (/\.map$/i.test(name)) return res.sendStatus(404);

  try {
    const output = await client.get(key.renderedOutput(d1 + d2 + rest));

    // null means a miss, but an empty string is a valid stored value
    if (output == null) return res.sendStatus(404);

    res.set("Cache-Control", "public, max-age=31536000, immutable");
    res.set("Content-Type", getContentType(name));
    return res.send(output);
  } catch (err) {
    // Not a missing file: say so with a 503 rather than a 404
    if (isRedisUnavailableError(err)) return next(err);
    return res.sendStatus(404);
  }
});

// Anything else under /template is not a CDN file
cdn.use("/template", (req, res) => res.sendStatus(404));

// Blog-specific static files, e.g.
// /blog_de64881e0dd94a5f8ba8f7aeaf807b86/_image_cache/739749f7-85eb-4b51-a6b9-c238b61c2c97.jpg
// Served from storage/assets with the semantics express.static had here:
// GET/HEAD only, a year of caching, dotfiles ignored, and a miss is a 404
// error rather than falling through to another handler.
cdn.use(async (req, res, next) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.statusCode = 405;
    res.setHeader("Allow", "GET, HEAD");
    res.setHeader("Content-Length", "0");
    return res.end();
  }

  let pathname;

  try {
    pathname = decodeURIComponent(req.path);
  } catch (err) {
    return next(httpError(400, "Bad Request"));
  }

  // pathname is /{blogID}/{path in the blog's assets}
  const match = /^\/(blog_[^/]+)\/(.+)$/.exec(pathname);

  if (!match || pathname.indexOf("\0") !== -1) {
    return next(httpError(404, "Not Found"));
  }

  if (match[2].split("/").indexOf("..") !== -1) {
    return next(httpError(403, "Forbidden"));
  }

  try {
    await assets.serve(req, res, match[1], match[2], {
      maxAge: "1y",
      dotfiles: "ignore",
    });
  } catch (err) {
    // The client went away after we started sending
    if (res.headersSent) return;

    if (err instanceof assets.NotFoundError) {
      return next(httpError(404, "Not Found"));
    }

    next(err);
  }
});

module.exports = cdn;

function httpError(status, message) {
  const err = new Error(message);
  err.status = err.statusCode = status;
  err.expose = true;
  return err;
}

/**
 * Get content type from view name
 */
function getContentType(viewName) {
  return mime.lookup(viewName) || 'text/plain';
}
