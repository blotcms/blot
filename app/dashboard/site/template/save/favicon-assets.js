const fs = require("fs-extra");
const os = require("os");
const { join } = require("path");
const sharp = require("sharp");
const toIco = require("to-ico");
const uuid = require("uuid/v4");

const ICO_SIZES = [16, 32, 48];
const PNG_SIZES = { png16: 16, png32: 32, appleTouch: 180 };
const MAX_PIXELS = 100 * 1000 * 1000;

function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

// A crop is only usable when all three coordinates are present and numeric.
// The form always submits the hidden crop_* fields, so when the client script
// did not run (or could not preview the image) they arrive as empty strings -
// treat that as "no crop" so the centered-square fallback below can run.
function parseCrop(crop) {
  if (!crop) return null;
  const x = Number(crop.x);
  const y = Number(crop.y);
  const size = Number(crop.size);
  if (
    crop.x === undefined || crop.x === null || crop.x === "" ||
    crop.y === undefined || crop.y === null || crop.y === "" ||
    crop.size === undefined || crop.size === null || crop.size === "" ||
    ![x, y, size].every(Number.isFinite)
  ) {
    return null;
  }
  return { x, y, size };
}

// Dimensions as the browser (and the cropper) sees them, i.e. after any EXIF
// orientation has been applied. Orientations 5-8 rotate the image a quarter
// turn, so width and height are swapped relative to the stored pixels.
function orientedDimensions(metadata) {
  const swap = metadata.orientation && metadata.orientation >= 5;
  return {
    width: swap ? metadata.height : metadata.width,
    height: swap ? metadata.width : metadata.height,
  };
}

function cropFor(metadata, crop) {
  const { width, height } = orientedDimensions(metadata);
  if (!width || !height || width * height > MAX_PIXELS) {
    throw badRequest("Please choose a reasonably sized image");
  }

  const parsed = parseCrop(crop);
  const fallbackSize = Math.min(width, height);
  if (!parsed) {
    return {
      left: Math.floor((width - fallbackSize) / 2),
      top: Math.floor((height - fallbackSize) / 2),
      width: fallbackSize,
      height: fallbackSize,
    };
  }

  const { x, y, size } = parsed;
  if (x < 0 || y < 0 || size <= 0 || x > 1 || y > 1 || size > 1) {
    throw badRequest("The selected favicon crop is invalid");
  }

  const left = Math.floor(x * width);
  const top = Math.floor(y * height);
  const side = Math.floor(size * Math.min(width, height));
  if (side < 1 || left + side > width || top + side > height) {
    throw badRequest("The selected favicon crop is outside the image");
  }

  return { left, top, width: side, height: side };
}

async function generate(sourcePath, outputDirectory, crop) {
  let metadata;
  try {
    metadata = await sharp(sourcePath, { pages: 1 }).metadata();
  } catch (_) {
    throw badRequest("Please choose an image for your favicon");
  }

  const extraction = cropFor(metadata, crop);
  const id = uuid();
  const prefix = `favicon-${id}`;
  const workDirectory = await fs.mkdtemp(join(os.tmpdir(), "blot-favicon-"));

  try {
    // rotate() with no argument bakes in the EXIF orientation before we crop,
    // so the extraction rectangle lines up with what the user saw. ensureAlpha()
    // guarantees 4-channel input: to-ico@1.1.5 mis-encodes 24-bit PNGs (e.g. a
    // straight RGB JPEG upload) into a malformed ICO otherwise.
    const source = sharp(sourcePath, { pages: 1 }).rotate().ensureAlpha().extract(extraction).png();
    const icoBuffers = await Promise.all(
      ICO_SIZES.map((size) => source.clone().resize(size, size).png().toBuffer())
    );
    await fs.writeFile(join(workDirectory, `${prefix}.ico`), await toIco(icoBuffers));
    await Promise.all(Object.entries(PNG_SIZES).map(([name, size]) =>
      source.clone().resize(size, size).png().toFile(join(workDirectory, `${prefix}-${size}.png`))
    ));

    await fs.ensureDir(outputDirectory);
    await Promise.all([
      fs.move(join(workDirectory, `${prefix}.ico`), join(outputDirectory, `${prefix}.ico`)),
      ...Object.values(PNG_SIZES).map((size) =>
        fs.move(join(workDirectory, `${prefix}-${size}.png`), join(outputDirectory, `${prefix}-${size}.png`))
      ),
    ]);

    return { id, prefix, crop: extraction };
  } finally {
    await fs.remove(workDirectory);
  }
}

module.exports = { generate, cropFor, ICO_SIZES, PNG_SIZES };
