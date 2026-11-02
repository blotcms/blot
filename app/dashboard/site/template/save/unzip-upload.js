const sandbox = require("sandbox");
const UploadValidationError = require("./upload-validation-error");
const {
  UPLOAD_MAX_RAW_FILES,
  UPLOAD_MAX_TOTAL_BYTES,
} = require("./constants");

// Reads an uploaded zip into the same { relativePath, buffer } records a
// folder drop produces, so everything downstream is identical.
//
// This is only responsible for not letting a hostile archive exhaust memory,
// and the archive is read in the sandbox (app/sandbox/jobs/unzip.js), which
// also refuses absolute and upward paths and symlinks. The path policy for
// everything else — hidden files, nesting — belongs to parse-uploaded-template,
// so a zip and a folder are judged by the same rules and produce the same
// messages.

// A ratio far above any template: HTML and CSS compress a few tens of times
const MAX_RATIO = 200;

const problem = (reason, message, path) =>
  new UploadValidationError([path ? { path, reason, message } : { reason, message }]);

// Why the sandbox refused an archive, in the words this upload has always used
const REFUSALS = {
  zip: (path) => problem("zip", "This file is not a zip archive we can read"),
  read: (path) =>
    path
      ? problem(
          "zip",
          "This file could not be read from the zip archive. It may be password protected or damaged.",
          path
        )
      : problem("zip", "This zip archive could not be read"),
  count: () =>
    problem("count", "This zip file contains far more than a template can use"),
  size: (path) =>
    problem("size", "This zip file contains too much to be a template", path),
  ratio: (path) =>
    problem("size", "This zip file contains more than it declares", path),
  path: () => problem("zip", "This zip archive could not be read"),
  symlink: () => problem("zip", "This zip archive could not be read"),
};

// The sandbox failing on the archive itself (too big for it, killed, out of
// time) is a problem with the file they chose. It being busy or gone is ours.
const FILE_FAILURES = {
  SANDBOX_INPUT_TOO_LARGE: () => REFUSALS.size(),
  SANDBOX_OUTPUT_TOO_LARGE: () => REFUSALS.size(),
  SANDBOX_FAILED: () => REFUSALS.read(),
  SANDBOX_KILLED: () => REFUSALS.read(),
  SANDBOX_TIMEOUT: () => REFUSALS.read(),
};

module.exports = async function unzipUpload (zipPath) {
  let result;

  try {
    result = await sandbox.run(
      "unzip",
      {
        maxEntries: UPLOAD_MAX_RAW_FILES,
        maxBytes: UPLOAD_MAX_TOTAL_BYTES,
        maxRatio: MAX_RATIO,
      },
      { path: zipPath }
    );
  } catch (err) {
    if (err && FILE_FAILURES[err.code]) throw FILE_FAILURES[err.code]();
    throw err;
  }

  const { error, files } = result.meta;

  if (error) {
    const refusal = REFUSALS[error.reason] || REFUSALS.read;
    throw refusal(error.path);
  }

  return files.map((relativePath, index) => ({
    relativePath,
    buffer: result.outputs[index],
  }));
};
