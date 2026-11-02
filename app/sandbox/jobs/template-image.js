// The pixel work for a template image setting (app/build/thumbnail/template-image.js),
// in the jail or in-process (see ../index.js). The args come from a process we
// treat as less trusted than this one, so they are checked here too:
//
//   { op: "check" }
//     decodes the first page, so corrupt pixel data is caught before anything
//     is saved. meta is { format, width, height, orientation }, no outputs.
//
//   { op: "generate", crop, shape, editable, sizes: [{ size, crop }] }
//     outputs are the original and then one thumbnail per size, all WebP; meta
//     is [{ width, height }] in the same order. crop is the normalized crop
//     (./crop.js). With editable the original is the whole image shrunk to
//     SOURCE_MAX and the crop only applies to the thumbnails.
//
//   { op: "regenerate", crop, shape, sizes }
//     the thumbnails again, from a stored original (the input), for a new crop
//     or shape. outputs and meta are one per size.

const sharp = require("sharp");
const { normalizeShape, applyShape } = require("./image-mask");
const { parseCrop, orientedDimensions } = require("./crop");

sharp.cache(false);

const MAX_PIXELS = 100 * 1000 * 1000;
const SOURCE_MAX = 2000;
const MAX_SIZES = 8;
const MAX_SIZE = 4096;
const CROP_FIELDS = ["x", "y", "width", "height", "size"];

const open = (input) => sharp(input, { pages: 1, limitInputPixels: MAX_PIXELS });

function checkCrop(crop) {
  if (crop === null || crop === undefined) return null;
  if (typeof crop !== "object" || Array.isArray(crop)) throw new Error("invalid crop");
  const out = {};
  for (const field of CROP_FIELDS) {
    const value = crop[field];
    if (value === undefined || value === null || value === "") continue;
    if (typeof value !== "number" && typeof value !== "string") throw new Error("invalid crop");
    out[field] = value;
  }
  return out;
}

function checkSizes(sizes) {
  if (!Array.isArray(sizes) || !sizes.length || sizes.length > MAX_SIZES) throw new Error("invalid sizes");
  return sizes.map((options) => {
    if (!options || typeof options !== "object") throw new Error("invalid size");
    if (!Number.isInteger(options.size) || options.size < 1 || options.size > MAX_SIZE) throw new Error("invalid size");
    if (typeof options.crop !== "boolean") throw new Error("invalid crop");
    return { size: options.size, crop: options.crop };
  });
}

// Non-square shapes are cleared to transparent, so templates can use the
// thumbnail as is
async function thumbnail(base, { size, crop }, shape) {
  const resized = base.clone().resize(size, size, {
    fit: crop ? "cover" : "inside",
    withoutEnlargement: !crop,
    position: sharp.strategy.entropy,
  });
  if (shape === "square") return resized.webp().toBuffer({ resolveWithObject: true });
  const { data, info } = await resized.png().toBuffer({ resolveWithObject: true });
  return applyShape(data, info.width, info.height, shape).webp().toBuffer({ resolveWithObject: true });
}

// One at a time, to keep the memory of the jail down
async function thumbnails(base, sizes, shape) {
  const meta = [];
  const outputs = [];
  for (const options of sizes) {
    const { data, info } = await thumbnail(base, options, shape);
    meta.push({ width: info.width, height: info.height });
    outputs.push(data);
  }
  return { meta, outputs };
}

async function check(input) {
  const image = open(input);
  const { format, width, height, orientation } = await image.metadata();
  await image.rotate().resize({ width: 1, height: 1, fit: "inside" }).toBuffer();
  return { meta: { format, width, height, orientation }, outputs: [] };
}

async function generate(args, input) {
  const crop = checkCrop(args.crop);
  const shape = normalizeShape(args.shape);
  const sizes = checkSizes(args.sizes);
  if (typeof args.editable !== "boolean") throw new Error("invalid editable");

  const image = open(input);
  const oriented = orientedDimensions(await image.metadata());
  const source = image.rotate().keepIccProfile();

  let original;
  let base;
  if (args.editable) {
    original = await source
      .clone()
      .resize(SOURCE_MAX, SOURCE_MAX, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: 90 })
      .toBuffer({ resolveWithObject: true });
    const selected = parseCrop(crop, original.info.width, original.info.height);
    const whole = sharp(original.data);
    base = selected ? whole.extract(selected) : whole;
  } else {
    const selected = parseCrop(crop, oriented.width, oriented.height);
    base = selected ? source.extract(selected) : source;
    original = await base.clone().webp().toBuffer({ resolveWithObject: true });
  }

  const made = await thumbnails(base, sizes, shape);
  return {
    meta: [{ width: original.info.width, height: original.info.height }].concat(made.meta),
    outputs: [original.data].concat(made.outputs),
  };
}

async function regenerate(args, input) {
  const crop = checkCrop(args.crop);
  const shape = normalizeShape(args.shape);
  const sizes = checkSizes(args.sizes);
  const whole = open(input);
  const { width, height } = await whole.clone().metadata();
  const selected = parseCrop(crop, width, height);
  return thumbnails(selected ? whole.extract(selected) : whole, sizes, shape);
}

async function run(args, input) {
  if (!args || typeof args !== "object") throw new Error("invalid arguments");
  if (args.op === "check") return check(input);
  if (args.op === "generate") return generate(args, input);
  if (args.op === "regenerate") return regenerate(args, input);
  throw new Error("invalid op");
}

module.exports = { run, MAX_PIXELS, SOURCE_MAX };
