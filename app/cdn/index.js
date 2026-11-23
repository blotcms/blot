const config = require("config");
const express = require("express");
const cdn = new express.Router();
const mime = require("mime-types");

const client = require("models/client");
const { isRedisUnavailableError } = require("helper/redisUnavailable");
const key = require("models/template/key");
const assets = require("storage/assets");
const folder = require("storage/folder");
const sendObject = require("storage/sendObject");
const publishZip = require("templates/demo/publishZip");
const {
  getStat,
  PENDING_VERSION,
} = require("blog/render/replaceFolderLinks/folderFile");

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

// The download ZIPs of the demo folders, e.g. /folders/bees-0123456789abcdef.zip,
// from the storage bucket's private folders/ prefix (templates/demo/
// publishZip). The hash is of the ZIP's files, so a URL never changes bytes.
// A missing ZIP isn't cached: a deploy may upload it a moment after the page
// that links it goes live.
cdn.get("/folders/:file", async (req, res, next) => {
  const file = req.params.file;
  const notFound = () => res.set("Cache-Control", "no-store").sendStatus(404);

  if (!publishZip.KEY.test(file)) return notFound();

  try {
    await sendObject(
      req,
      res,
      publishZip.PREFIX + file,
      {
        maxAge: "1y",
        immutable: true,
        headers: { "Content-Type": "application/zip" },
      },
      {
        notFound: () => Object.assign(new Error("Not found"), { status: 404 }),
        label: "[cdn] folder zip stream failed " + file,
      }
    );
  } catch (err) {
    if (err.status === 404) return notFound();
    next(err);
  }
});

// Serves files directly from a blog's folder e.g.
// /blog_1234/folder/v-1a2b3c4d/favicon.ico
// /folder/v-1a2b3c4d/blog_1234/favicon.ico (links baked before #2695)
// The first form is the file's key in the storage bucket with the version
// inserted, so in production Bunny fetches it from the bucket and only
// v-pending reaches this route (see "Folder files from the bucket" in
// config/storage-bucket/README.md). The second form, still in posts, feeds
// and emails built before, is always served here.
//
// With the semantics express.static had here: a year of caching, dotfiles
// ignored, a directory without its trailing slash redirected to it. Anything
// missing or behind a symlink is a bare 404, which exposes no path and does
// not fall through to another static root. Any other HTTP error from sending
// an existing file, such as a 416 for a bad range, goes on as it did from
// express.static.
//
// v-pending is an image the build linked before it synced (see
// app/build/plugins/folderAssets). It is cached for a short time, so a page
// or feed copy that still links it shows the image soon after it arrives,
// and a replaced image isn't stuck behind it for a year; its 404 is
// cacheable for a minute. Bunny overrides the origin's cache time, so its
// edge rule for v-pending does the same at the edge (see "Edge rules" in
// config/storage-bucket/README.md). The path is as the author wrote it, so
// it is found case-insensitively, like the build's own lookup.
cdn.use("/folder/v-:version", (req, res, next) => {
  const pathname = decodedPath(req);

  // pathname is /{blogID}/{path in the blog's folder}
  const match = pathname && /^\/(blog_[^/]+)(\/.*)?$/.exec(pathname);

  if (!match) return res.sendStatus(404);

  return serveFolderFile(req, res, next, match[1], match[2] || "");
});

cdn.use("/:blogID/folder/v-:version", (req, res, next) => {
  if (!/^blog_[^/]+$/.test(req.params.blogID)) return next();

  const pathname = decodedPath(req);

  if (!pathname) return res.sendStatus(404);

  // Express gives "/" for both /blog_1/folder/v-1 and /blog_1/folder/v-1/,
  // so tell the first apart, for the trailing-slash redirect
  const atRoot = req.originalUrl.replace(/\?.*$/, "") === req.baseUrl;

  return serveFolderFile(
    req,
    res,
    next,
    req.params.blogID,
    atRoot ? "" : pathname
  );
});

// The request's path below the route, decoded, or null if it isn't valid
// percent-encoding
function decodedPath(req) {
  try {
    return decodeURIComponent(req.path);
  } catch (err) {
    return null;
  }
}

// relPath is the decoded path in the blog's folder: "/" for the folder
// itself, "" for the folder without its trailing slash
async function serveFolderFile(req, res, next, blogID, relPath) {
  const pending = req.params.version === PENDING_VERSION;

  if (
    relPath.indexOf("\0") !== -1 ||
    relPath
      .split("/")
      .some((segment) => segment === ".." || segment.charAt(0) === ".")
  ) {
    return res.sendStatus(404);
  }

  try {
    let stat;
    const requested = relPath;

    relPath = relPath || "/";

    if (pending) {
      ({ stat, path: relPath } = await getStat(blogID, relPath));
    } else {
      stat = await folder.stat(blogID, relPath);
    }

    // Only ever an image's URL, never a directory's
    if (pending && stat.isDirectory) return pendingNotFound(res);

    if (stat.isDirectory && requested.slice(-1) !== "/") {
      return res.redirect(301, req.originalUrl.replace(/^[^?]*/, "$&/"));
    }

    if (req.method !== "GET" && req.method !== "HEAD")
      return methodNotAllowed(res);

    // A trailing slash serves the directory's index.html
    await folder.serve(req, res, blogID, relPath, {
      maxAge: pending ? "1h" : "1y",
    });
  } catch (err) {
    // The client went away after we started sending
    if (res.headersSent) return;
    if (err.status && err.status !== 404) return next(err);
    if (pending) return pendingNotFound(res);
    res.sendStatus(404);
  }
}

function pendingNotFound(res) {
  res.set("Cache-Control", "public, max-age=60");
  res.sendStatus(404);
}

// Template output from the {{#cdn}} helper, stored in Redis by hash, e.g.
// /template/{hash[0:2]}/{hash[2:4]}/{hash[4:]}/{basename}
// A miss is a 404 and must not fall through to the blog asset handler below.
cdn.get("/template/:d1/:d2/:rest/:name", async (req, res, next) => {
  const { d1, d2, rest, name } = req.params;

  if (
    !/^[a-f0-9]{2}$/.test(d1) ||
    !/^[a-f0-9]{2}$/.test(d2) ||
    !/^[a-f0-9]{28}$/.test(rest)
  ) {
    return res.sendStatus(404);
  }

  // The name only picks the Content-Type, but a view basename never holds these
  if (/[/\\\0]/.test(name) || name.startsWith("..")) return res.sendStatus(404);

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
    return methodNotAllowed(res);
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

function methodNotAllowed(res) {
  res.statusCode = 405;
  res.setHeader("Allow", "GET, HEAD");
  res.setHeader("Content-Length", "0");
  return res.end();
}

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
  return mime.lookup(viewName) || "text/plain";
}
