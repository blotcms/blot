const shouldIgnoreFile = require("clients/util/shouldIgnoreFile");
const path = require("path");

const UNSUPPORTED_FILE_EXTENSIONS = [".paper"];

const hasUnsupportedExtension = (filePath = "") => {
  const normalizedPath = String(filePath).toLowerCase();
  return UNSUPPORTED_FILE_EXTENSIONS.some((extension) =>
    normalizedPath.endsWith(extension)
  );
};

// ext4 (and most Linux filesystems) reject any path component over 255
// bytes and any full path over 4096 bytes with ENAMETOOLONG. Checking this
// locally lets us skip a destination we already know is unwriteable instead
// of downloading the file from Dropbox first and failing on the write.
const NAME_MAX_BYTES = 255;
const PATH_MAX_BYTES = 4096;

const exceedsFilesystemPathLimits = (destination = "") => {
  if (Buffer.byteLength(destination, "utf8") > PATH_MAX_BYTES) return true;

  return destination
    .split(path.sep)
    .some((component) => Buffer.byteLength(component, "utf8") > NAME_MAX_BYTES);
};

module.exports = {
  MAX_FILE_SIZE: 100 * 1024 * 1024, // 100 MB
  UNSUPPORTED_FILE_EXTENSIONS,
  hasUnsupportedExtension,
  isDotfileOrDotfolder: shouldIgnoreFile,
  exceedsFilesystemPathLimits,
};
