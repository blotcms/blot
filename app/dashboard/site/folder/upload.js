const assertNoSymlinks = require("helper/assertNoSymlinks");
const fs = require("fs-extra");
const path = require("path");
const clients = require("clients");
const localPath = require("helper/localPath");
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
        overwriteSet.add(item.normalize("NFC").replace(/\\/g, "/").replace(/^\/+/, ""));
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

const removeTempFiles = async (uploads) => {
  await Promise.all(
    uploads.map(({ file }) => fs.remove(file.path).catch(() => {}))
  );
};

const writeClientFile = (client, blogID, relativePath, contents) =>
  new Promise((resolve, reject) => {
    client.write(blogID, relativePath, contents, (err) => {
      if (err) return reject(err);
      resolve();
    });
  });

module.exports = async (req, res, next) => {
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

    const destination = resolveDestination(req.blog.id, normalizedRelativePath);

    if (!destination.valid) {
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
      absolutePath: destination.absolute,
    });
  }

  try {
    const existingChecks = await Promise.all(
      accepted.map(async (entry) => ({
        ...entry,
        exists: await fs.pathExists(entry.absolutePath),
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

        let contents;

        try {
          await assertNoSymlinks(localPath(req.blog.id, "/"), entry.absolutePath);
          contents = await fs.readFile(entry.upload.file.path);
          if (client) {
            await writeClientFile(client, req.blog.id, entry.relativePath, contents);
          } else {
            await fs.outputFile(entry.absolutePath, contents, { overwrite: true });
          }
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

        try {
          await folder.update(`/${entry.relativePath}`);
        } catch (err) {
          throw err;
        }

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
