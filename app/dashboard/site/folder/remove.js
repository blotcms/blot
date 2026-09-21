const assertNoSymlinks = require("helper/assertNoSymlinks");
const fs = require("fs-extra");
const path = require("path");
const clients = require("clients");
const localPath = require("helper/localPath");
const establishSyncLock = require("sync/establishSyncLock");
const folderMiddleware = require("./index");

const isAbsolutePathAttempt = (inputPath = "") => {
  const value = String(inputPath).trim();

  if (!value) return false;

  return (
    value.startsWith("/") ||
    value.startsWith("\\") ||
    /^[a-zA-Z]:[\\/]/.test(value)
  );
};

const resolveDestination = (blogID, relativePath) => {
  const root = localPath(blogID, "/");
  const absolute = localPath(blogID, `/${relativePath}`);

  const relative = path.relative(root, absolute);
  const outside =
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative);

  if (outside) {
    return { valid: false, absolute };
  }

  return { valid: true, absolute };
};

const removeClientPath = (client, blogID, relativePath) =>
  new Promise((resolve, reject) => {
    client.remove(blogID, relativePath, (err) => {
      if (err) return reject(err);
      resolve();
    });
  });

// N.B. In production this POST runs on green while the page you are redirected
// to renders on blue (config/openresty/conf/http.conf, $dashboard_upstream).
// Don't rely on in-process cache invalidation here; see dashboard/site/index.js.
module.exports = async (req, res) => {
  const rawPath = (req.params.path || req.body.path || "")
    .normalize("NFC")
    .replace(/\\/g, "/")
    .trim();

  if (!rawPath) {
    return res.status(400).json({
      ok: false,
      removed: null,
      error: "Missing path",
    });
  }

  if (isAbsolutePathAttempt(rawPath)) {
    return res.status(400).json({
      ok: false,
      removed: null,
      error: "Absolute paths are not allowed",
    });
  }

  const normalizedPath = decodeURIComponent(rawPath.replace(/^\/+/, ""));
  const destination = resolveDestination(req.blog.id, normalizedPath);

  if (!destination.valid) {
    return res.status(400).json({
      ok: false,
      removed: null,
      error: "Path escapes blog folder",
    });
  }

  const exists = await fs.pathExists(destination.absolute);

  if (!exists) {
    return res.status(404).json({
      ok: false,
      removed: normalizedPath,
      error: "Path not found",
    });
  }

  const { folder, done } = await establishSyncLock(req.blog.id);

  // done() bumps blog.cacheID, which is what invalidates the folder cache on
  // the container that renders the listing (blue). Release before responding
  // so the client's follow-up refresh can't beat it.
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    await done();
  };

  try {
    await assertNoSymlinks(localPath(req.blog.id, "/"), destination.absolute);
    const connectedClient =
      (req.blog.client && typeof req.blog.client.remove === "function"
        ? req.blog.client
        : clients[req.blog.client]) || null;

    if (connectedClient) {
      await removeClientPath(connectedClient, req.blog.id, normalizedPath);
    } else {
      await fs.remove(destination.absolute);
    }

    await folder.update(`/${normalizedPath}`);

    if (typeof folderMiddleware.invalidateCache === "function") {
      folderMiddleware.invalidateCache(req.blog);
    }

    await release();

    return res.json({
      ok: true,
      removed: normalizedPath,
      error: null,
    });
  } catch (err) {
    await release();

    if (err && err.code === "ENOENT") {
      return res.status(404).json({
        ok: false,
        removed: normalizedPath,
        error: "Path not found",
      });
    }

    if (err && (err.code === "EACCES" || err.code === "EPERM" || err.code === "ELOOP")) {
      return res.status(403).json({
        ok: false,
        removed: normalizedPath,
        error: "Permission denied",
      });
    }

    if (err && err.name === "ValidationError") {
      return res.status(400).json({
        ok: false,
        removed: normalizedPath,
        error: err.message,
      });
    }

    return res.status(502).json({
      ok: false,
      removed: normalizedPath,
      error: err && err.message ? err.message : "Failed to remove path",
    });
  } finally {
    await release();
  }
};
