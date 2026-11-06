const fs = require("fs-extra");
const path = require("path");
const clients = require("clients");
const storage = require("storage/folder"); // reads only
const blogFolder = require("clients/folder");
const establishSyncLock = require("sync/establishSyncLock");
const shouldIgnoreFile = require("clients/util/shouldIgnoreFile");

const toArray = (value) => {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  return [value];
};

const parseJSON = (value) => {
  if (typeof value !== "string") return null;

  try {
    return JSON.parse(value);
  } catch (err) {
    return null;
  }
};

const collectFiles = (files = {}) => {
  const collected = [];

  for (const field of Object.keys(files)) {
    const items = toArray(files[field]);
    items.forEach((file, index) => {
      if (file && file.path) {
        collected.push({ field, index, file });
      }
    });
  }

  return collected;
};

const getPathPayload = (body = {}) => {
  if (Array.isArray(body.relativePaths)) return body.relativePaths;
  if (Array.isArray(body.paths)) return body.paths;

  return (
    parseJSON(body.paths) ||
    parseJSON(body.relativePaths) ||
    parseJSON(body.pathMap) ||
    parseJSON(body.files)
  );
};

const getMetadataLookups = (body = {}) => {
  const pathPayload = getPathPayload(body);
  const byIndex = new Map();
  const byField = new Map();
  const byFieldIndex = new Map();

  if (Array.isArray(pathPayload)) {
    pathPayload.forEach((entry, index) => {
      if (typeof entry === "string") {
        byIndex.set(String(index), entry);
        return;
      }

      if (!entry || typeof entry !== "object") return;

      const rel =
        entry.relativePath || entry.path || entry.destination || entry.name;
      if (!rel || typeof rel !== "string") return;

      if (entry.field && entry.index !== undefined) {
        byFieldIndex.set(`${entry.field}:${entry.index}`, rel);
        return;
      }

      if (entry.field) {
        byField.set(String(entry.field), rel);
        return;
      }

      if (entry.index !== undefined) {
        byIndex.set(String(entry.index), rel);
      }
    });
  } else if (pathPayload && typeof pathPayload === "object") {
    for (const key of Object.keys(pathPayload)) {
      if (typeof pathPayload[key] !== "string") continue;

      if (key.includes(":")) {
        byFieldIndex.set(key, pathPayload[key]);
      } else if (/^\d+$/.test(key)) {
        byIndex.set(key, pathPayload[key]);
      } else {
        byField.set(key, pathPayload[key]);
      }
    }
  }

  return { byIndex, byField, byFieldIndex };
};

const parseBoolean = (value) => {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;
  if (typeof value !== "string") return false;

  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
};

const getOverwriteSet = (body = {}) => {
  const overwriteAll = parseBoolean(body.overwrite);
  const normalizeOverwriteField = (value) => {
    if (Array.isArray(value)) return value;

    if (typeof value === "string") {
      const parsed = parseJSON(value);
      if (Array.isArray(parsed)) return parsed;
    }

    return null;
  };

  const payload = [body.overwritePaths, body.overwriteList, body.overwriteFiles]
    .map(normalizeOverwriteField)
    .find((value) => value !== null);

  const overwriteSet = new Set();

  if (Array.isArray(payload)) {
    payload.forEach((item) => {
      if (typeof item === "string" && item.trim()) {
        overwriteSet.add(
          item.normalize("NFC").replace(/\\/g, "/").replace(/^\/+/, "")
        );
      }
    });
  }

  return { overwriteAll, overwriteSet };
};

const isAbsolutePathAttempt = (inputPath = "") => {
  const value = String(inputPath).trim();

  if (!value) return false;

  return (
    value.startsWith("/") ||
    value.startsWith("\\") ||
    /^[a-zA-Z]:[\\/]/.test(value)
  );
};

const resolveRelativePath = (upload, globalIndex, lookups) => {
  const fromLookup =
    lookups.byFieldIndex.get(`${upload.field}:${upload.index}`) ||
    lookups.byField.get(upload.field) ||
    lookups.byIndex.get(String(globalIndex));

  return (fromLookup || upload.file.originalFilename || "")
    .normalize("NFC")
    .replace(/\\/g, "/")
    .trim();
};

// Whether a relative path climbs out of the blog's folder
const escapesFolder = (relativePath) => {
  const normalized = path.posix.normalize(relativePath);

  return normalized === ".." || normalized.startsWith("../");
};

const removeTempFiles = async (uploads) => {
  await Promise.all(
    uploads.map(({ file }) => fs.remove(file.path).catch(() => {}))
  );
};

// N.B. In production this POST runs on green while the page you are redirected
// to renders on blue (proxy/config/http.conf, $dashboard_upstream).
// Don't rely on in-process cache invalidation here; see dashboard/site/index.js.
const uploadFiles = async (req, res, next) => {
  const uploads = collectFiles(req.files);
  const lookups = getMetadataLookups(req.body || {});
  const overwriteConfig = getOverwriteSet(req.body || {});
  const dryRun =
    req.body.dryRun === "1" ||
    req.body.dryRun === "true" ||
    req.body.commit === "false" ||
    req.query.dryRun === "1" ||
    req.query.dryRun === "true";

  const rejected = [];
  const accepted = [];

  for (let i = 0; i < uploads.length; i++) {
    const upload = uploads[i];
    const relativePath = resolveRelativePath(upload, i, lookups);

    if (!relativePath) {
      rejected.push({
        field: upload.field,
        filename: upload.file.originalFilename,
        reason: "invalid",
        message: "Missing relative destination path",
      });
      continue;
    }

    if (isAbsolutePathAttempt(relativePath)) {
      rejected.push({
        field: upload.field,
        filename: upload.file.originalFilename,
        relativePath,
        reason: "invalid",
        message: "Absolute destination paths are not allowed",
      });
      continue;
    }

    const normalizedRelativePath = relativePath.replace(/^\/+/, "");

    if (shouldIgnoreFile(normalizedRelativePath)) {
      rejected.push({
        field: upload.field,
        filename: upload.file.originalFilename,
        relativePath: normalizedRelativePath,
        reason: "ignored",
      });
      continue;
    }

    if (escapesFolder(normalizedRelativePath)) {
      rejected.push({
        field: upload.field,
        filename: upload.file.originalFilename,
        relativePath: normalizedRelativePath,
        reason: "invalid",
        message: "Path escapes blog folder",
      });
      continue;
    }

    accepted.push({
      upload,
      relativePath: normalizedRelativePath,
    });
  }

  try {
    const existingChecks = await Promise.all(
      accepted.map(async (entry) => ({
        ...entry,
        exists: await storage.exists(req.blog.id, `/${entry.relativePath}`),
      }))
    );

    if (dryRun) {
      return res.json({
        dryRun: true,
        create: existingChecks
          .filter((entry) => !entry.exists)
          .map((entry) => entry.relativePath),
        overwrite: existingChecks
          .filter((entry) => entry.exists)
          .map((entry) => entry.relativePath),
        rejected,
      });
    }

    const client = req.blog.client && clients[req.blog.client];
    const results = [];
    const { folder, done } = await establishSyncLock(req.blog.id);

    try {
      for (const entry of existingChecks) {
        const canOverwrite =
          !entry.exists ||
          overwriteConfig.overwriteAll ||
          overwriteConfig.overwriteSet.has(entry.relativePath);

        if (!canOverwrite) {
          results.push({
            path: entry.relativePath,
            overwritten: false,
            skipped: true,
            reason: "overwrite_not_allowed",
          });
          continue;
        }

        const destination = `/${entry.relativePath}`;

        try {
          if (client) {
            // Throws ELOOP if the path or one of its parents is a symlink
            await storage.stat(req.blog.id, destination).catch((err) => {
              if (!(err instanceof storage.NotFoundError)) throw err;
            });
          }

          // A client is given the contents (read into memory); a blog with
          // no client has the temp file copied in without buffering it
          await blogFolder.writeFrom(
            req.blog,
            client ? entry.relativePath : destination,
            entry.upload.file.path
          );
        } catch (err) {
          const errorResult = {
            path: entry.relativePath,
            overwritten: entry.exists,
          };

          if (client) {
            errorResult.local = { skipped: true, reason: "client_write" };
            errorResult.client = {
              success: false,
              name: req.blog.client,
              error: err.message,
            };
          } else {
            errorResult.local = { success: false, error: err.message };
            errorResult.client = { skipped: true };
          }

          results.push(errorResult);
          continue;
        }

        await folder.update(`/${entry.relativePath}`);

        if (!client) {
          results.push({
            path: entry.relativePath,
            overwritten: entry.exists,
            local: { success: true },
            client: { skipped: true },
          });
          continue;
        }

        results.push({
          path: entry.relativePath,
          overwritten: entry.exists,
          local: { skipped: true, reason: "client_write" },
          client: { success: true, name: req.blog.client },
        });
      }
    } finally {
      await done();
    }

    return res.json({
      dryRun: false,
      results,
      rejected,
    });
  } catch (err) {
    return next(err);
  } finally {
    await removeTempFiles(uploads);
  }
};

// Errors from before the try (e.g. a missing request body) reach Express as
// next(err), not as an unhandled rejection
module.exports = (req, res, next) => uploadFiles(req, res, next).catch(next);
