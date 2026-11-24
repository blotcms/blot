const shouldIgnoreFile = require("clients/util/shouldIgnoreFile");

const UNSUPPORTED_FILE_EXTENSIONS = [".paper"];

const hasUnsupportedExtension = (filePath = "") => {
  const normalizedPath = String(filePath).toLowerCase();
  return UNSUPPORTED_FILE_EXTENSIONS.some((extension) =>
    normalizedPath.endsWith(extension)
  );
};

// A blog's folder lives in the storage bucket (storage/folder/s3.js), where a
// file is the object {blogID}/folder/{path} and S3 refuses a key over 1024
// bytes. Names have no limit of their own: the content cache shortens a long
// one on local disk (storage/folder/cache.js). Checking the length here lets
// us skip a destination we already know is unwriteable instead of downloading
// the file from Dropbox first and failing on the write. The margin covers the
// prefix and a directory marker's trailing slash.
const MAX_KEY_BYTES = 1024;
const KEY_PREFIX_BYTES = 64;

const exceedsStorageLimits = (destination = "") =>
  Buffer.byteLength(destination, "utf8") > MAX_KEY_BYTES - KEY_PREFIX_BYTES;

// Dropbox never returns HTTP 507 itself - a WriteError with reason
// "insufficient_space" comes back as a 409 with a nested error tag (see
// isInsufficientSpaceError below). We reuse 507 as our own account.error_code
// sentinel for "setup ran out of Dropbox space", since it isn't used
// elsewhere in this client and reads naturally as "insufficient storage".
const INSUFFICIENT_SPACE_ERROR_CODE = 507;

// Dropbox API errors are HTTP 409s whose JSON body has an error_summary like
// "path/insufficient_space/..." (see WriteErrorInsufficientSpace in the SDK's
// type definitions). Matching on the summary string is the same approach
// already used (commented out) in reset-from-blot.js for disallowed_name.
const isInsufficientSpaceError = (err) => {
  if (!err) return false;
  if (err.code === "DROPBOX_INSUFFICIENT_SPACE") return true;
  const summary = err.error && err.error.error_summary;
  return (
    typeof summary === "string" && summary.indexOf("insufficient_space") !== -1
  );
};

// True whenever it is NOT safe to trust Dropbox as the source of truth for
// this blog: either the initial transfer is still in progress / never
// finished (transfer_pending), or it stopped specifically because Dropbox
// ran out of space (error_code === INSUFFICIENT_SPACE_ERROR_CODE - kept as
// its own check even though reset-from-blot.js also sets transfer_pending
// in that case, so this stays true for any account written before
// transfer_pending existed). Every automatic path that could otherwise run
// resetToBlot's delete-local-files-with-no-Dropbox-counterpart logic, or the
// webhook-driven sync in sync/index.js, must check this first.
//
// A move of the blog's files into a subfolder of the app folder that hasn't
// finished (move_folder_id, see database.js) counts too: until it does, the
// blog's folder on Dropbox is half at the root and half in the subfolder.
const transferIncomplete = (account) =>
  !!account &&
  (account.transfer_pending === true ||
    account.error_code === INSUFFICIENT_SPACE_ERROR_CODE ||
    !!account.move_folder_id);

module.exports = {
  MAX_FILE_SIZE: 100 * 1024 * 1024, // 100 MB
  UNSUPPORTED_FILE_EXTENSIONS,
  hasUnsupportedExtension,
  isDotfileOrDotfolder: shouldIgnoreFile,
  exceedsStorageLimits,
  INSUFFICIENT_SPACE_ERROR_CODE,
  isInsufficientSpaceError,
  transferIncomplete,
};
