const fs = require("fs-extra");
const unzipUpload = require("./unzip-upload");
const UploadValidationError = require("./upload-validation-error");
const { UPLOAD_MAX_RAW_FILES, UPLOAD_MAX_TOTAL_BYTES } = require("./constants");

// Reads what multiparty left in req.files into { relativePath, buffer }
// records for parse-uploaded-template.
//
// A dropped folder arrives as one field per file plus a relativePaths map,
// because originalFilename alone cannot describe a directory. A dropped zip
// arrives as a single 'zip' field.

const ZIP_FIELD = "zip";

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
    toArray(files[field]).forEach((file, index) => {
      if (file && file.path) collected.push({ field, index, file });
    });
  }

  return collected;
};

// Accepts the shape our client sends — [{ field, index, relativePath }] — and
// a plain array of paths, in upload order, as a fallback.
const getRelativePaths = (body = {}) => {
  const payload = Array.isArray(body.relativePaths)
    ? body.relativePaths
    : parseJSON(body.relativePaths);

  const byFieldIndex = new Map();
  const byPosition = new Map();

  if (!Array.isArray(payload)) return { byFieldIndex, byPosition };

  payload.forEach((item, position) => {
    if (typeof item === "string") {
      byPosition.set(position, item);
      return;
    }

    if (!item || typeof item !== "object") return;

    const relativePath = item.relativePath || item.path || item.name;
    if (typeof relativePath !== "string") return;

    if (item.field !== undefined) {
      byFieldIndex.set(`${item.field}:${item.index || 0}`, relativePath);
      return;
    }

    byPosition.set(position, relativePath);
  });

  return { byFieldIndex, byPosition };
};

const badRequest = (message) => {
  const err = new Error(message);
  err.status = 400;
  return err;
};

module.exports = async function collectUploadEntries(req) {
  const files = req.files || {};
  const body = req.body || {};

  const zipFiles = toArray(files[ZIP_FIELD]).filter(
    (file) => file && file.path
  );
  const otherFiles = collectFiles(files).filter(
    (upload) => upload.field !== ZIP_FIELD
  );

  if (!zipFiles.length && !otherFiles.length) {
    throw badRequest("No files were uploaded");
  }

  if (zipFiles.length && otherFiles.length) {
    throw badRequest("Upload either a zip file or a folder, not both");
  }

  if (zipFiles.length > 1) {
    throw badRequest("Upload one zip file at a time");
  }

  if (zipFiles.length) {
    if (zipFiles[0].size > UPLOAD_MAX_TOTAL_BYTES) {
      throw new UploadValidationError([
        {
          reason: "size",
          message: "This zip file is too large to be a template",
        },
      ]);
    }

    return {
      entries: await unzipUpload(zipFiles[0].path),
      // A zip need not contain a wrapper directory, so its own name is the
      // last thing left to name the template after
      fallbackName: String(zipFiles[0].originalFilename || "")
        .replace(/\.zip$/i, "")
        .trim(),
    };
  }

  // The raw cap, not the template's file limit: the parser applies that once
  // it has set aside system noise and hidden files. Comparing against the
  // lower limit here would reject a template kept in a git working tree
  // before anything had a chance to discard its .git entries.
  if (otherFiles.length > UPLOAD_MAX_RAW_FILES) {
    throw new UploadValidationError([
      {
        reason: "count",
        message: `You dropped ${otherFiles.length} files, which is far more than a template can use`,
      },
    ]);
  }

  const { byFieldIndex, byPosition } = getRelativePaths(body);

  // Check the declared sizes before reading anything into memory
  const declaredBytes = otherFiles.reduce(
    (total, upload) => total + (upload.file.size || 0),
    0
  );

  if (declaredBytes > UPLOAD_MAX_TOTAL_BYTES) {
    throw new UploadValidationError([
      {
        reason: "size",
        message: "These files are too large to be a template",
      },
    ]);
  }

  const entries = [];

  for (let position = 0; position < otherFiles.length; position++) {
    const upload = otherFiles[position];

    const relativePath =
      byFieldIndex.get(`${upload.field}:${upload.index}`) ||
      byPosition.get(position) ||
      upload.file.originalFilename;

    entries.push({
      relativePath,
      buffer: await fs.readFile(upload.file.path),
    });
  }

  return { entries, fallbackName: "" };
};
