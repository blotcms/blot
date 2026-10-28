const fs = require("fs-extra");
const os = require("os");
const { join } = require("path");
const sharp = require("sharp");
const { v4: uuid } = require("uuid");
const { THUMBNAILS } = require("./config");
const { normalizeShape } = require("./image-mask");
const { parseCrop, orientedDimensions: dimensions } = require("./crop");

const MAX_PIXELS = 100 * 1000 * 1000;
const SUPPORTED = new Set(["jpeg", "png", "webp", "gif", "tiff", "avif", "svg"]);

function invalid(message) { const error = new Error(message); error.status = 400; return error; }
async function validate(sourcePath, crop, shape) {
  normalizeShape(shape);
  let metadata;
  try { metadata = await sharp(sourcePath, { pages: 1, limitInputPixels: MAX_PIXELS }).metadata(); }
  catch (_) { throw invalid("Please choose a valid image"); }

  const oriented = dimensions(metadata);
  if (!SUPPORTED.has(metadata.format) || !oriented.width || !oriented.height || oriented.width * oriented.height > MAX_PIXELS) {
    throw invalid("Please choose a supported image under 100 megapixels");
  }

  parseCrop(crop, oriented.width, oriented.height);

  // metadata() only reads the image header. Decode a small derivative here so
  // corrupt pixel data is rejected before a shared template is forked.
  try {
    await sharp(sourcePath, { pages: 1, limitInputPixels: MAX_PIXELS })
      .rotate()
      .resize({ width: 1, height: 1, fit: "inside" })
      .toBuffer();
  } catch (_) {
    throw invalid("Please choose a valid image");
  }

  return { width: oriented.width, height: oriented.height, format: metadata.format };
}

// Resizes `operation` to a thumbnail at `destination`.
async function renderThumbnail(operation, options, destination) {
  const info = await operation.resize(options.size, options.size, {
    fit: options.crop ? "cover" : "inside",
    withoutEnlargement: !options.crop,
    position: sharp.strategy.entropy,
  }).webp().toFile(destination);
  return { width: info.width, height: info.height };
}

// Decode one page deliberately: animated uploads have a deterministic first
// frame. This mirrors the existing thumbnail pipeline's non-animated output.
//
// `source`, when passed, is a sharp() instance already opened on sourcePath
// (e.g. by a caller that also needs to derive a favicon from the same
// upload) - cloning it avoids decoding the same file from disk twice.
async function generate(sourcePath, outputDirectory, crop, { source } = {}) {
  let metadata;
  try {
    metadata = await (source ? source.clone() : sharp(sourcePath, { pages: 1, limitInputPixels: MAX_PIXELS })).metadata();
  }
  catch (_) { throw invalid("Please choose a valid image"); }
  const oriented = dimensions(metadata);
  if (!SUPPORTED.has(metadata.format) || !oriented.width || !oriented.height || oriented.width * oriented.height > MAX_PIXELS) throw invalid("Please choose a supported image under 100 megapixels");

  const prefix = `image-${uuid()}`;
  const temporary = await fs.mkdtemp(join(os.tmpdir(), "blot-template-image-"));
  const names = { original: `${prefix}-original.webp` };
  const published = [];
  Object.keys(THUMBNAILS).forEach((name) => { names[name] = `${prefix}-${name}.webp`; });
  try {
    const orientedSource = (source ? source.clone() : sharp(sourcePath, { pages: 1, limitInputPixels: MAX_PIXELS })).rotate().keepIccProfile();
    const selected = parseCrop(crop, oriented.width, oriented.height);
    const base = selected ? orientedSource.extract(selected) : orientedSource;
    const originalInfo = await base.clone().webp().toFile(join(temporary, names.original));
    const results = {};
    await Promise.all(Object.entries(THUMBNAILS).map(async ([name, options]) => {
      results[name] = await renderThumbnail(base.clone(), options, join(temporary, names[name]));
      results[name].name = names[name];
    }));
    await fs.ensureDir(outputDirectory);
    for (const name of Object.values(names)) {
      const destination = join(outputDirectory, name);
      await fs.move(join(temporary, name), destination);
      published.push(destination);
    }
    return { prefix, original: { name: names.original, width: originalInfo.width, height: originalInfo.height }, thumbnails: results };
  } catch (error) {
    await Promise.all(published.map((path) => fs.remove(path).catch(() => {})));
    throw error;
  } finally { await fs.remove(temporary); }
}

// Re-renders just the square thumbnail from an already stored (and already
// cropped) original.
async function generateSquare(original, outputDirectory) {
  const name = `image-${uuid()}-square.webp`;
  await fs.ensureDir(outputDirectory);
  const info = await renderThumbnail(sharp(original, { pages: 1, limitInputPixels: MAX_PIXELS }), THUMBNAILS.square, join(outputDirectory, name));
  return { name, ...info };
}

module.exports = { generate, generateSquare, validate, MAX_PIXELS, parseCrop, normalizeShape };
