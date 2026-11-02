// exif.js — exiftool-backed, path-based

const fs = require("node:fs/promises");
const sandbox = require("sandbox");

const BASIC_WHITELIST = [
  "Make",
  "Model",
  "ExposureTime",
  "FNumber",
  "ISO",
  "FocalLength",
  "LensMake",
  "LensModel",
  "Flash",
  "ImageDescription",
];

const FULL_WHITELIST = [
  ...BASIC_WHITELIST,
  "GPSPosition",
  "GPSLatitude",
  "GPSLongitude",
  "GPSAltitude",
];

// exiftool runs in the sandbox's exif job, which returns just these fields.
// Any failure, sandbox or exiftool, is null.
function execExifTool(filePath, fields) {
  return sandbox.run("exif", { fields }, { path: filePath }).then(
    (result) => result.meta,
    () => null
  );
}

async function parseExif(filePath, mode = "off") {
  if (mode === "off") return {};

  if (!filePath || typeof filePath !== "string") return {};
  try {
    const stat = await fs.stat(filePath).catch(() => null);
    if (!stat || !stat.isFile() || stat.size === 0) return {};
    const raw = await execExifTool(
      filePath,
      mode === "full" ? FULL_WHITELIST : BASIC_WHITELIST
    );

    const result = {};

    Object.keys(raw || {}).forEach((key) => {
      if (
        (mode === "full" && FULL_WHITELIST.includes(key)) ||
        (mode === "basic" && BASIC_WHITELIST.includes(key))
      ) {
        result[key] = raw[key];
      }
    });

    // map FocalLength '50.0 mm' to '50'
    // you could change the output of exiftool with -n flag
    // but we like some of the other formatting it does
    if (result.FocalLength && typeof result.FocalLength === "string") {
      const parts = result.FocalLength.split(" ");
      if (parts.length === 2) {
        const val = parseFloat(parts[0]);
        if (!isNaN(val)) result.FocalLength = val;
      }
    }

    return result;
  } catch {
    return {};
  }
}

module.exports = {
  parseExif,
};
