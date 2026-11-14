// exif.js — exiftool-backed, path-based

const fs = require("node:fs/promises");
const sandbox = require("sandbox");
const markdown = require("./markdown");

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

// The photo's caption, from EXIF ImageDescription, IPTC Caption-Abstract or
// XMP dc:description, reconciled by the Metadata Working Group's rules. Like
// the rest of the photo's metadata it is read only when the EXIF setting is on.
const DESCRIPTION = "MWG:Description";

// exiftool runs in the sandbox's exif job, which returns just these fields.
// Any failure, sandbox or exiftool, is null.
function execExifTool(filePath, fields) {
  return sandbox.run("exif", { fields }, { path: filePath }).then(
    (result) => result.meta,
    () => null
  );
}

// Resolves to { exif, caption }: exif holds the fields the blog's EXIF
// setting allows, caption the photo's caption as inline HTML, or null when it
// has none or only a camera's default. Both are empty when EXIF is off.
// Never rejects.
async function readMetadata(filePath, mode = "off") {
  const empty = { exif: {}, caption: null };

  if (mode !== "basic" && mode !== "full") return empty;
  if (!filePath || typeof filePath !== "string") return empty;
  try {
    const stat = await fs.stat(filePath).catch(() => null);
    if (!stat || !stat.isFile() || stat.size === 0) return empty;

    const whitelist = mode === "full" ? FULL_WHITELIST : BASIC_WHITELIST;
    const raw =
      (await execExifTool(filePath, [...whitelist, DESCRIPTION])) || {};

    const result = {};

    whitelist.forEach((key) => {
      if (Object.prototype.hasOwnProperty.call(raw, key))
        result[key] = raw[key];
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

    // Rendered as inline Markdown. A blank description is left as it is.
    const description = markdown.render(result.ImageDescription);
    if (description) result.ImageDescription = description;

    return { exif: result, caption: markdown.caption(raw[DESCRIPTION]) };
  } catch {
    return empty;
  }
}

// Resolves to the fields the EXIF setting allows. Never rejects.
async function parseExif(filePath, mode = "off") {
  return (await readMetadata(filePath, mode)).exif;
}

module.exports = {
  parseExif,
  readMetadata,
};
