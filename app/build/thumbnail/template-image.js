const fs = require("fs-extra");
const os = require("os");
const { join } = require("path");
const sharp = require("sharp");
const { v4: uuid } = require("uuid");
const { THUMBNAILS } = require("./config");

const MAX_PIXELS = 100 * 1000 * 1000;
const SUPPORTED = new Set(["jpeg", "png", "webp", "gif", "tiff", "avif", "svg"]);

function invalid(message) { const error = new Error(message); error.status = 400; return error; }
function dimensions(metadata) {
  const swap = metadata.orientation >= 5 && metadata.orientation <= 8;
  return { width: swap ? metadata.height : metadata.width, height: swap ? metadata.width : metadata.height };
}
function parseCrop(value, width, height) {
  if (!value || [value.x, value.y, value.size].some((v) => v === "" || v == null)) return null;
  const x = Number(value.x), y = Number(value.y), size = Number(value.size);
  if (![x, y, size].every(Number.isFinite) || x < 0 || y < 0 || size <= 0 || x > 1 || y > 1 || size > 1) throw invalid("The selected image crop is invalid");
  const side = Math.floor(size * Math.min(width, height));
  const extraction = { left: Math.floor(x * width), top: Math.floor(y * height), width: side, height: side };
  if (!side || extraction.left + side > width || extraction.top + side > height) throw invalid("The selected image crop is outside the image");
  return extraction;
}

// Decode one page deliberately: animated uploads have a deterministic first
// frame. This mirrors the existing thumbnail pipeline's non-animated output.
async function generate(sourcePath, outputDirectory, crop) {
  let metadata;
  try { metadata = await sharp(sourcePath, { pages: 1, limitInputPixels: MAX_PIXELS }).metadata(); }
  catch (_) { throw invalid("Please choose a valid image"); }
  const oriented = dimensions(metadata);
  if (!SUPPORTED.has(metadata.format) || !oriented.width || !oriented.height || oriented.width * oriented.height > MAX_PIXELS) throw invalid("Please choose a supported image under 100 megapixels");

  const prefix = `image-${uuid()}`;
  const temporary = await fs.mkdtemp(join(os.tmpdir(), "blot-template-image-"));
  const names = { original: `${prefix}-original.webp` };
  Object.keys(THUMBNAILS).forEach((name) => { names[name] = `${prefix}-${name}.webp`; });
  try {
    const base = sharp(sourcePath, { pages: 1, limitInputPixels: MAX_PIXELS }).rotate().keepIccProfile();
    const originalInfo = await base.clone().webp().toFile(join(temporary, names.original));
    const selected = parseCrop(crop, oriented.width, oriented.height);
    const results = {};
    await Promise.all(Object.entries(THUMBNAILS).map(async ([name, options]) => {
      let operation = base.clone();
      if (name === "square" && selected) operation = operation.extract(selected);
      const fit = options.crop ? "cover" : "inside";
      const info = await operation.resize(options.size, options.size, {
        fit, withoutEnlargement: true,
        position: selected ? "centre" : sharp.strategy.entropy,
      }).webp().toFile(join(temporary, names[name]));
      results[name] = { name: names[name], width: info.width, height: info.height };
    }));
    await fs.ensureDir(outputDirectory);
    await Promise.all(Object.values(names).map((name) => fs.move(join(temporary, name), join(outputDirectory, name))));
    return { prefix, original: { name: names.original, width: originalInfo.width, height: originalInfo.height }, thumbnails: results };
  } finally { await fs.remove(temporary); }
}

module.exports = { generate, MAX_PIXELS, parseCrop };
