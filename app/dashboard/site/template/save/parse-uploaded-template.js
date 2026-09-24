const Mustache = require("mustache");
const makeSlug = require("helper/makeSlug");
const shouldIgnoreFile = require("clients/util/shouldIgnoreFile");
const improveJSONErrorMessage = require("models/template/util/improveJSONErrorMessage");
const improveMustacheErrorMessage = require("models/template/util/improveMustacheErrorMessage");
const UploadValidationError = require("./upload-validation-error");
const {
  UPLOAD_MAX_FILES,
  UPLOAD_MAX_RAW_FILES,
  UPLOAD_MAX_TOTAL_BYTES,
  UPLOAD_MAX_VIEW_BYTES,
  UPLOAD_MAX_VIEW_PAYLOAD_BYTES,
  UPLOAD_MAX_WRAPPER_DEPTH,
  UPLOAD_FALLBACK_NAME,
  PACKAGE,
} = require("./constants");

// Turns the files a user dropped into the arguments we need to create a
// template. This is a pure function over in-memory entries: it does not touch
// Redis or the filesystem, so everything it decides can be tested directly.
//
// Entries look like { relativePath: "my-theme/index.html", buffer: <Buffer> }.
//
// Returns { name, locals, views, ignored, warnings } or throws an
// UploadValidationError carrying every problem found.

const prettyBytes = (bytes) => `${Math.round(bytes / 1024)}kb`;

// Client-supplied paths reach us as arbitrary strings and their final segment
// becomes a Redis key, so normalize before we compare or store anything.
const normalizePath = (input) =>
  String(input === undefined || input === null ? "" : input)
    .normalize("NFC")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/{2,}/g, "/")
    .trim();

const isAbsolutePathAttempt = (input = "") => {
  const value = String(input).trim();
  if (!value) return false;
  return (
    value.startsWith("/") ||
    value.startsWith("\\") ||
    /^[a-zA-Z]:[\\/]/.test(value)
  );
};

// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\x00-\x1f\x7f]/;

const invalidPathReason = (original, normalized) => {
  if (!normalized) return "This file has no name";

  if (isAbsolutePathAttempt(original)) {
    return "Absolute paths are not allowed";
  }

  if (CONTROL_CHARACTERS.test(normalized)) {
    return "This file's name contains invalid characters";
  }

  const segments = normalized.split("/");

  for (const segment of segments) {
    if (!segment.trim()) return "This file's path contains an empty folder name";
    if (segment === "." || segment === "..") {
      return "Paths cannot navigate outside the folder you dropped";
    }
  }

  return null;
};

// A folder drop gives us 'my-theme/index.html'; selecting that folder's
// contents gives us 'index.html'. Strip any directory every file shares so
// both produce the same template. A zip of a folder containing a folder can
// nest twice, so repeat, but never strip so far that a file has no name left.
const stripWrapperDirectories = (entries) => {
  let stripped = entries;
  let outermost = null;

  for (let depth = 0; depth < UPLOAD_MAX_WRAPPER_DEPTH; depth++) {
    if (!stripped.length) break;

    const firstSegments = stripped.map((entry) => entry.path.split("/")[0]);
    const everyEntryIsNested = stripped.every(
      (entry) => entry.path.split("/").length > 1
    );
    const shareOneDirectory = firstSegments.every(
      (segment) => segment === firstSegments[0]
    );

    if (!everyEntryIsNested || !shareOneDirectory) break;

    if (outermost === null) outermost = firstSegments[0];

    stripped = stripped.map((entry) => ({
      ...entry,
      path: entry.path.split("/").slice(1).join("/"),
    }));
  }

  return { entries: stripped, wrapperName: outermost };
};

// Views are stored as text and rendered by Mustache. Reject anything which is
// not valid UTF-8 rather than silently storing replacement characters, which
// is what reading a binary file as utf-8 would otherwise do.
const isValidUTF8 = (buffer) => {
  if (buffer.includes(0)) return false;
  return Buffer.compare(Buffer.from(buffer.toString("utf8"), "utf8"), buffer) === 0;
};

// setView runs the view through viewModel, which expects these to be objects.
// A string there is rejected deep inside the model and surfaces as a bare
// TypeError, so name the file and the setting instead.
const OBJECT_SETTINGS = ["locals", "partials", "retrieve"];

const invalidSettingReason = (view) => {
  for (const setting of OBJECT_SETTINGS) {
    const value = view[setting];

    // A manifest which says "locals": null means it has none. viewModel does
    // not accept null for an object, so drop the key rather than letting it
    // reach setView and fail there.
    if (value === null) {
      delete view[setting];
      continue;
    }

    if (value === undefined) continue;

    if (typeof value !== "object" || Array.isArray(value)) {
      return `'${setting}' must be a set of values, not ${
        Array.isArray(value) ? "a list" : typeof value
      }`;
    }
  }

  return null;
};

// A view's url may be a single path or a list of them, but every one of them
// has to be text before it reaches setView
const invalidUrlReason = (value) => {
  if (value === undefined || value === null) return null;

  if (typeof value === "string") return null;

  if (Array.isArray(value)) {
    return value.every((item) => typeof item === "string")
      ? null
      : "a list of urls may only contain text";
  }

  return "a url must be text, or a list of text";
};

const parsePackage = (buffer, problems, warnings) => {
  // Views are checked for this, and the manifest deserves it more: decoding
  // replaces bad bytes with U+FFFD, after which the JSON still parses and a
  // quietly corrupted name or setting would be saved.
  if (!isValidUTF8(buffer)) {
    problems.push({
      path: PACKAGE,
      reason: "binary",
      message: "package.json is not valid UTF-8 text",
    });
    return {};
  }

  const contents = buffer.toString("utf8");
  let parsed;

  try {
    parsed = JSON.parse(contents);
  } catch (e) {
    problems.push({
      path: PACKAGE,
      reason: "manifest",
      message: improveJSONErrorMessage(e, contents),
    });
    return {};
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    problems.push({
      path: PACKAGE,
      reason: "manifest",
      message: "package.json must contain a JSON object",
    });
    return {};
  }

  // 'enabled' would install the template on the live site and 'localEditing'
  // would move it into the user's folder. Neither is something a dropped
  // folder should decide, so ignore both and say so.
  if (parsed.enabled) {
    warnings.push(
      "package.json set 'enabled' — the template was created but not installed. Use 'Install' on its settings page to switch your site to it."
    );
  }

  if (parsed.localEditing) {
    warnings.push(
      "package.json set 'localEditing' — the template was created in the editor. Use 'Local editing' on its settings page to move it into your folder."
    );
  }

  const manifest = {};

  if (typeof parsed.name === "string" && parsed.name.trim()) {
    manifest.name = parsed.name.trim();
  }

  if (parsed.locals && typeof parsed.locals === "object" && !Array.isArray(parsed.locals)) {
    manifest.locals = parsed.locals;
  } else if (parsed.locals !== undefined) {
    warnings.push("package.json 'locals' was ignored because it is not an object");
  }

  if (parsed.views && typeof parsed.views === "object" && !Array.isArray(parsed.views)) {
    manifest.views = parsed.views;
  } else if (parsed.views !== undefined) {
    warnings.push("package.json 'views' was ignored because it is not an object");
  }

  return manifest;
};

module.exports = function parseUploadedTemplate (entries = [], options = {}) {
  const problems = [];
  const warnings = [];
  const ignored = [];

  if (!entries.length) {
    problems.push({
      reason: "empty",
      message: "No files were uploaded",
    });
    throw new UploadValidationError(problems);
  }

  // Only a guard against walking something enormous. The limit users actually
  // meet is applied further down, once we know which files are usable.
  if (entries.length > UPLOAD_MAX_RAW_FILES) {
    problems.push({
      reason: "count",
      message: `This folder contains ${entries.length} files, which is far more than a template can use`,
    });
    throw new UploadValidationError(problems);
  }

  // 1. Normalize and reject unusable paths
  const normalized = [];

  for (const entry of entries) {
    const path = normalizePath(entry.relativePath);
    const reason = invalidPathReason(entry.relativePath, path);

    if (reason) {
      problems.push({
        path: String(entry.relativePath || "").slice(0, 200),
        reason: "invalid-path",
        message: reason,
      });
      continue;
    }

    normalized.push({ path, buffer: entry.buffer });
  }

  // 2. Set aside system noise and hidden files. shouldIgnoreFile covers
  // .DS_Store, .git, editor swap files and cloud sync metadata; setView
  // separately refuses names beginning with a dot.
  const kept = [];

  for (const entry of normalized) {
    if (shouldIgnoreFile(entry.path)) {
      ignored.push({ path: entry.path, reason: "system-file" });
      continue;
    }

    if (entry.path.split("/").some((segment) => segment.startsWith("."))) {
      ignored.push({ path: entry.path, reason: "hidden-file" });
      continue;
    }

    kept.push(entry);
  }

  if (!kept.length && !problems.length) {
    problems.push({
      reason: "empty",
      message: "None of the files you dropped can be used in a template",
    });
  }

  // 3. Strip the directory the files share, if any
  const { entries: flattened, wrapperName } = stripWrapperDirectories(kept);

  // 4. Templates are a flat list of views: setView refuses names containing a
  // slash, and collapsing to basenames would silently merge a/x.html with
  // b/x.html. So say plainly that subdirectories are not supported.
  const roots = [];

  for (const entry of flattened) {
    if (entry.path.includes("/")) {
      problems.push({
        path: entry.path,
        reason: "nested",
        message:
          "Templates cannot contain subfolders — move this file to the top level of your template",
      });
      continue;
    }

    roots.push(entry);
  }

  // 5. The manifest describes the views but is never a view itself.
  //
  // A zip may hold two entries of the same name — append and update workflows
  // keep the older one — and taking whichever comes first would quietly build
  // the template from a stale manifest. Duplicate view names are caught below,
  // but package.json is filtered out before that runs, so check it here.
  const manifestEntries = roots.filter((entry) => entry.path === PACKAGE);

  if (manifestEntries.length > 1) {
    problems.push({
      path: PACKAGE,
      reason: "duplicate",
      message: `This upload contains ${manifestEntries.length} package.json files, so there is no way to tell which describes the template`,
    });
  }

  const manifestEntry = manifestEntries[0];

  const viewEntries = roots.filter((entry) => entry.path !== PACKAGE);

  // writeToFolder always generates a package.json beside the views, so a view
  // whose name only differs in case would land on the same path on a
  // case-insensitive filesystem and one would overwrite the other.
  for (const entry of viewEntries) {
    if (entry.path.toLowerCase() === PACKAGE) {
      problems.push({
        path: entry.path,
        reason: "duplicate",
        message: `A template file cannot be called '${entry.path}' — that name is reserved for the template's package.json`,
      });
    }
  }

  // Now that the noise is out of the way and the manifest is set aside, count
  // what would actually become views. Dropping a template kept in a git
  // working tree should not fail because .git contributed hundreds of entries
  // we already discarded, and a template with exactly the maximum number of
  // views should still round trip with its package.json alongside them.
  if (viewEntries.length > UPLOAD_MAX_FILES) {
    problems.push({
      reason: "count",
      message: `A template cannot contain more than ${UPLOAD_MAX_FILES} files — this one has ${viewEntries.length}`,
    });
    throw new UploadValidationError(problems);
  }

  const manifest = manifestEntry
    ? parsePackage(manifestEntry.buffer, problems, warnings)
    : {};

  // 6. Validate each view before we create anything
  const seen = new Map();
  const views = [];
  let totalBytes = 0;

  for (const entry of viewEntries) {
    const name = entry.path;

    // Redis view names are case sensitive but the filesystems these files came
    // from often are not, so two entries can arrive which cannot both exist.
    const fingerprint = name.toLowerCase();

    if (seen.has(fingerprint)) {
      problems.push({
        path: name,
        reason: "duplicate",
        message: `This file has the same name as ${seen.get(fingerprint)}`,
      });
      continue;
    }

    seen.set(fingerprint, name);

    totalBytes += entry.buffer.length;

    if (entry.buffer.length > UPLOAD_MAX_VIEW_BYTES) {
      problems.push({
        path: name,
        reason: "size",
        message: `This file is ${prettyBytes(entry.buffer.length)} — the largest a template file can be is ${prettyBytes(UPLOAD_MAX_VIEW_BYTES)}`,
      });
      continue;
    }

    if (!isValidUTF8(entry.buffer)) {
      problems.push({
        path: name,
        reason: "binary",
        message:
          "This file is not text. Images and other assets belong in your template's settings, not its source files.",
      });
      continue;
    }

    const content = entry.buffer.toString("utf8");

    try {
      Mustache.render(content, {});
    } catch (e) {
      problems.push({
        path: name,
        reason: "template",
        message: improveMustacheErrorMessage(e, content),
      });
      continue;
    }

    const settings = (manifest.views && manifest.views[name]) || {};
    const view = { ...settings, name, content };

    // setView normalizes every url it is given, and urlNormalizer requires a
    // string. It does that inside an asynchronous callback which nothing
    // catches, so a number in this array would leave the request hanging
    // rather than failing. Refuse it here instead.
    const badUrl = invalidUrlReason(view.url) || invalidUrlReason(view.urlPatterns);

    if (badUrl) {
      problems.push({
        path: name,
        reason: "manifest",
        message: `package.json gives this file an invalid url: ${badUrl}`,
      });
      continue;
    }

    const badSetting = invalidSettingReason(view);

    if (badSetting) {
      problems.push({
        path: name,
        reason: "manifest",
        message: `package.json gives this file an invalid setting: ${badSetting}`,
      });
      continue;
    }

    // setView accepts an array of urls and derives urlPatterns from it
    if (Array.isArray(view.urlPatterns) && view.urlPatterns.length) {
      view.url = view.urlPatterns;
    }

    // Match readFromFolder, and package.generate which omits a view's url from
    // the manifest exactly when it equals '/' + name. Using the source code
    // editor's rule instead ('foo.html' -> '/foo') would change every view's
    // url on a download-then-upload round trip.
    view.url = view.url || "/" + name;

    delete view.urlPatterns;

    // The per-file limit above measures the source. What setView actually
    // weighs is the whole view once package.json's settings are merged in, so
    // a modest file with a large locals object can still be refused there.
    // Measure what it will measure.
    const payloadSize = Buffer.byteLength(JSON.stringify(view));

    if (payloadSize > UPLOAD_MAX_VIEW_PAYLOAD_BYTES) {
      problems.push({
        path: name,
        reason: "size",
        message: `This file and its settings in package.json come to ${prettyBytes(
          payloadSize
        )} together — the most a template file can be is ${prettyBytes(
          UPLOAD_MAX_VIEW_PAYLOAD_BYTES
        )}`,
      });
      continue;
    }

    views.push(view);
  }

  if (totalBytes > UPLOAD_MAX_TOTAL_BYTES) {
    problems.push({
      reason: "size",
      message: `These files total ${prettyBytes(totalBytes)} — the largest a template can be is ${prettyBytes(UPLOAD_MAX_TOTAL_BYTES)}`,
    });
  }

  if (!views.length && !problems.length) {
    problems.push({
      reason: "empty",
      message: "A template needs at least one template file",
    });
  }

  // 7. Warn about manifest settings for files which were not uploaded
  if (manifest.views) {
    const uploaded = new Set(views.map((view) => view.name));

    for (const name of Object.keys(manifest.views)) {
      if (!uploaded.has(name)) {
        warnings.push(`package.json describes '${name}' but no such file was uploaded`);
      }
    }
  }

  if (problems.length) throw new UploadValidationError(problems);

  // The manifest is the template's own idea of its name. Failing that, the
  // folder it was dropped in, then the zip file it arrived in.
  //
  // A name has to survive makeSlug to be usable: the template's id, and so the
  // address of every page of its editor, is derived from it. '!!!' slugs to
  // nothing, which would create a template at an id of just the owner and
  // redirect to the template index rather than the new template. Skip past any
  // name which leaves nothing behind.
  const name =
    [manifest.name, wrapperName, options.fallbackName, UPLOAD_FALLBACK_NAME]
      .map((candidate) =>
        typeof candidate === "string" ? candidate.trim().slice(0, 100) : ""
      )
      .find((candidate) => candidate && makeSlug(candidate)) ||
    UPLOAD_FALLBACK_NAME;

  return {
    name: name.slice(0, 100),
    locals: manifest.locals || {},
    views,
    ignored,
    warnings,
  };
};
