const path = require("path");

const MAX_CHARACTERS = 120;
const MAX_BYTES = 240;
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARACTERS = /[\u0000-\u001f\u007f-\u009f<>:"'`&|?*]/g;
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

function truncate(value) {
  let result = "";
  let characters = 0;
  let bytes = 0;

  // Iteration by code point avoids splitting surrogate pairs.
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");

    if (characters + 1 > MAX_CHARACTERS || bytes + characterBytes > MAX_BYTES) {
      break;
    }

    result += character;
    characters += 1;
    bytes += characterBytes;
  }

  return result;
}

function clean(value, extensions) {
  // path.basename does not recognize separators from the other platform.
  let identifier = path.posix.basename(String(value || "").replace(/\\/g, "/"));

  for (const extension of extensions) {
    const suffix = String(extension || "").replace(/^\.?/, ".");

    if (
      suffix !== "." &&
      identifier.toLowerCase().endsWith(suffix.toLowerCase())
    ) {
      identifier = identifier.slice(0, -suffix.length);
      break;
    }
  }

  return truncate(
    identifier
      .normalize("NFC")
      .replace(UNSAFE_CHARACTERS, "")
      .replace(/[/\\]/g, "")
      .replace(/\s+/g, " ")
      .replace(/^[. ]+|[. ]+$/g, "")
  );
}

function isValid(identifier) {
  return Boolean(
    identifier &&
    identifier !== "." &&
    identifier !== ".." &&
    !WINDOWS_RESERVED_NAME.test(identifier)
  );
}

/**
 * Produce the human-facing name used for an import's download and ZIP folder.
 * This value is deliberately independent of the immutable import ID.
 */
module.exports = function normalizeIdentifier(value, options) {
  options = options || {};
  const extensions = Array.isArray(options.extensions)
    ? options.extensions
    : options.extension
      ? [options.extension]
      : [];
  const identifier = clean(value, extensions);

  if (isValid(identifier)) {
    return identifier;
  }

  // Source labels are controlled by the caller, but clean them too so the
  // helper remains safe if it is reused with a dynamic fallback later.
  const fallback = clean(options.fallback || "Import", []);
  return isValid(fallback) ? fallback : "Import";
};

module.exports.MAX_CHARACTERS = MAX_CHARACTERS;
module.exports.MAX_BYTES = MAX_BYTES;
