// exif.js — exiftool-backed, path-based

const { execFile } = require("node:child_process");
const fs = require("node:fs/promises");

const EXIFTOOL = process.env.EXIFTOOL_PATH || "exiftool";

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

function execExifTool(filePath, extraArgs = []) {
  return new Promise((resolve) => {
    const args = [
      "-j", // JSON
      filePath,
      ...extraArgs,
    ];
    execFile(EXIFTOOL, args, (err, stdout) => {
      if (err) return resolve(null);
      try {
        const parsed = JSON.parse(stdout);
        resolve(Array.isArray(parsed) && parsed.length ? parsed[0] : null);
      } catch {
        resolve(null);
      }
    });
  });
}

async function parseExif(filePath, mode = "off") {
  if (mode === "off") return {};

  if (!filePath || typeof filePath !== "string") return {};
  try {
    const stat = await fs.stat(filePath).catch(() => null);
    if (!stat || !stat.isFile() || stat.size === 0) return {};
    const raw = await execExifTool(filePath);

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
