// Converts an image (HEIC, AVIF, TIFF, WebP...) to PNG, in the jail or
// in-process (see ../index.js). The one output is the PNG.
//
// Args: none, or { exif: ["Make", ...] } to read the image's EXIF as well, from
// the same bytes, so the caller needs no second job (and no second jail and
// read of the file) for it. meta.exif is then what the exif job returns for
// those fields: an object, or null if there is none or exiftool failed. A
// failing exiftool never fails the conversion.

const sharp = require("sharp");
const { MAX_INPUT_PIXELS } = require("./encode");
const { extract, validFields } = require("./exif");

sharp.cache(false);

// An image of at most this many pixels is decoded (4 bytes a pixel, about
// 100 MB) with exiftool, a perl process of some tens of MB, running beside it
// in the jail's 512 MiB. A larger one is read for its EXIF first, so the two
// never hold their memory together.
const CONCURRENT_PIXELS = 25 * 1000 * 1000;

async function convert(input) {
  const { data, info } = await sharp(input, {
    limitInputPixels: MAX_INPUT_PIXELS,
  })
    .png()
    .toBuffer({ resolveWithObject: true });
  return { meta: { width: info.width, height: info.height }, outputs: [data] };
}

async function pixels(input) {
  try {
    const { width, height } = await sharp(input, {
      limitInputPixels: MAX_INPUT_PIXELS,
    }).metadata();
    return width * height;
  } catch (err) {
    return Infinity;
  }
}

async function run(args, input) {
  const fields = args && args.exif;

  if (fields === undefined) return convert(input);

  if (!validFields(fields)) throw new Error("invalid fields");

  const read = () => extract(fields, input).catch(() => null);

  if ((await pixels(input)) > CONCURRENT_PIXELS) {
    const exif = await read();
    const result = await convert(input);
    result.meta.exif = exif;
    return result;
  }

  const [exif, result] = await Promise.all([read(), convert(input)]);
  result.meta.exif = exif;
  return result;
}

module.exports = { run };
