const path = require("path");
const storage = require("storage/folder"); // reads only
const blogFolder = require("clients/folder");
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

// Whether a relative path climbs out of the blog's folder
const escapesFolder = (relativePath) => {
  const normalized = path.posix.normalize(relativePath);

  return normalized === ".." || normalized.startsWith("../");
};

// N.B. In production this POST runs on green while the page you are redirected
// to renders on blue (proxy/config/http.conf, $dashboard_upstream).
// Don't rely on in-process cache invalidation here; see dashboard/site/index.js.
const removeFolderPath = async (req, res) => {
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

  if (escapesFolder(normalizedPath)) {
    return res.status(400).json({
      ok: false,
      removed: null,
      error: "Path escapes blog folder",
    });
  }

  const blogID = req.blog.id;
  const target = `/${normalizedPath}`;

  // A symlink is left for the check inside the lock, which refuses it
  const exists = await storage.stat(blogID, target).then(
    () => true,
    (err) => err.code === "ELOOP"
  );

  if (!exists) {
    return res.status(404).json({
      ok: false,
      removed: normalizedPath,
      error: "Path not found",
    });
  }

  let folder, done;

  try {
    ({ folder, done } = await establishSyncLock(req.blog.id));
  } catch (err) {
    if (err && err.message === "Failed to acquire folder lock") {
      res.set("Retry-After", "10");
      return res.status(423).json({
        ok: false,
        removed: null,
        error: "Folder is locked by another sync; retry later",
      });
    }

    throw err;
  }

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
    // Throws ELOOP if the path or one of its parents is a symlink
    await storage.stat(blogID, target).catch((err) => {
      if (!(err instanceof storage.NotFoundError)) throw err;
    });

    await blogFolder.remove(req.blog, normalizedPath);

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

    if (
      err &&
      (err.code === "EACCES" || err.code === "EPERM" || err.code === "ELOOP")
    ) {
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

// Errors from before the try (a malformed path, a failed stat, a lock error
// other than 423) reach Express as next(err), not as an unhandled rejection
module.exports = (req, res, next) => removeFolderPath(req, res).catch(next);
