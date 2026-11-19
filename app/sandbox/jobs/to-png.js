// Converts an image (HEIC, AVIF, TIFF, WebP...) to PNG, in the jail or
// in-process (see ../index.js). No args; the one output is the PNG.

const sharp = require("sharp");
const { MAX_INPUT_PIXELS } = require("./encode");

sharp.cache(false);

async function run(args, input) {
  const { data, info } = await sharp(input, {
    limitInputPixels: MAX_INPUT_PIXELS,
  })
    .png()
    .toBuffer({ resolveWithObject: true });
  return { meta: { width: info.width, height: info.height }, outputs: [data] };
}

module.exports = { run };
