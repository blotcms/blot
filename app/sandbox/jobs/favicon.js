// Makes a favicon set from one image (app/dashboard/site/template/save/favicon-assets.js),
// in the jail or in-process (see ../index.js). The args come from a process we
// treat as less trusted than this one, so they are checked here too:
//
//   { extract: { left, top, width, height }, shape, ico: [16, 32, 48], png: [16, 32, 180] }
//
// extract is in pixels of the oriented image. outputs are the ICO and then one
// PNG per png size, in order; meta is null.

const sharp = require("sharp");
const toIco = require("to-ico");
const { normalizeShape, applyShape } = require("./image-mask");

sharp.cache(false);

const MAX_PIXELS = 100 * 1000 * 1000;
const MAX_SIZES = 8;
const MAX_SIZE = 512;

function checkSizes(sizes) {
  if (!Array.isArray(sizes) || !sizes.length || sizes.length > MAX_SIZES) throw new Error("invalid sizes");
  for (const size of sizes) {
    if (!Number.isInteger(size) || size < 1 || size > MAX_SIZE) throw new Error("invalid size");
  }
  return sizes;
}

function checkExtract(extract) {
  if (!extract || typeof extract !== "object") throw new Error("invalid extract");
  const out = {};
  for (const field of ["left", "top", "width", "height"]) {
    const value = extract[field];
    if (!Number.isInteger(value) || value < 0) throw new Error("invalid extract");
    out[field] = value;
  }
  if (out.width < 1 || out.height < 1) throw new Error("invalid extract");
  return out;
}

async function run(args, input) {
  if (!args || typeof args !== "object") throw new Error("invalid arguments");
  const extract = checkExtract(args.extract);
  const shape = normalizeShape(args.shape);
  const ico = checkSizes(args.ico);
  const png = checkSizes(args.png);

  // rotate() with no argument bakes in the EXIF orientation before we crop,
  // so the extraction rectangle lines up with what the user saw. ensureAlpha()
  // guarantees 4-channel input: to-ico@1.1.5 mis-encodes 24-bit PNGs (e.g. a
  // straight RGB JPEG upload) into a malformed ICO otherwise.
  const source = sharp(input, { pages: 1, limitInputPixels: MAX_PIXELS })
    .rotate()
    .ensureAlpha()
    .extract(extract)
    .png();

  // One size at a time, to keep the memory of the jail down
  const render = async (size) => {
    const { data, info } = await source
      .clone()
      .resize(size, size, { fit: "cover", position: sharp.strategy.entropy })
      .png()
      .toBuffer({ resolveWithObject: true });
    return applyShape(data, info.width, info.height, shape).png().toBuffer();
  };

  const icoParts = [];
  for (const size of ico) icoParts.push(await render(size));
  const outputs = [await toIco(icoParts)];
  for (const size of png) outputs.push(await render(size));
  return { meta: null, outputs };
}

module.exports = { run };
