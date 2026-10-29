const fs = require("fs-extra");
const os = require("os");
const { join } = require("path");
const sharp = require("sharp");
const { v4: uuid } = require("uuid");
const { THUMBNAILS } = require("./config");
const { normalizeShape, applyShape } = require("./image-mask");
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

// Resizes `operation` to a thumbnail at `destination`. Non-square shapes are
// cleared to transparent, so templates can use the thumbnail as is.
async function renderThumbnail(operation, options, destination, shape) {
  const resized = operation.resize(options.size, options.size, {
    fit: options.crop ? "cover" : "inside",
    withoutEnlargement: !options.crop,
    position: sharp.strategy.entropy,
  });
  if (shape === "square") {
    const info = await resized.webp().toFile(destination);
    return { width: info.width, height: info.height };
  }
  const { data, info } = await resized.png().toBuffer({ resolveWithObject: true });
  const out = await applyShape(data, info.width, info.height, shape).webp().toFile(destination);
  return { width: out.width, height: out.height };
}

// Every thumbnail is cut to `shape`, so templates can use any of them as is.
async function renderThumbnails(base, names, directory, shape) {
  const results = {};
  await Promise.all(Object.entries(THUMBNAILS).map(async ([name, options]) => {
    results[name] = await renderThumbnail(base.clone(), options, join(directory, names[name]), shape);
    results[name].name = names[name];
  }));
  return results;
}

// Decode one page deliberately: animated uploads have a deterministic first
// frame. This mirrors the existing thumbnail pipeline's non-animated output.
//
// `source`, when passed, is a sharp() instance already opened on sourcePath
// (e.g. by a caller that also needs to derive a favicon from the same
// upload) - cloning it avoids decoding the same file from disk twice.
async function generate(sourcePath, outputDirectory, crop, { source, shape: requestedShape } = {}) {
  const shape = normalizeShape(requestedShape);
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
    const results = await renderThumbnails(base, names, temporary, shape);
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

// Re-renders the thumbnails from an already stored (and already cropped,
// unmasked) original, for when the photo's shape changes without a new upload.
async function regenerate(original, outputDirectory, requestedShape) {
  const shape = normalizeShape(requestedShape);
  const prefix = `image-${uuid()}`;
  const names = {};
  Object.keys(THUMBNAILS).forEach((name) => { names[name] = `${prefix}-${name}.webp`; });
  const temporary = await fs.mkdtemp(join(os.tmpdir(), "blot-template-image-"));
  const published = [];
  try {
    const thumbnails = await renderThumbnails(sharp(original, { pages: 1, limitInputPixels: MAX_PIXELS }), names, temporary, shape);
    await fs.ensureDir(outputDirectory);
    for (const name of Object.values(names)) {
      const destination = join(outputDirectory, name);
      await fs.move(join(temporary, name), destination);
      published.push(destination);
    }
    return { thumbnails };
  } catch (error) {
    await Promise.all(published.map((path) => fs.remove(path).catch(() => {})));
    throw error;
  } finally { await fs.remove(temporary); }
}

module.exports = { generate, regenerate, validate, MAX_PIXELS, parseCrop, normalizeShape };
