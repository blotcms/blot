const fs = require("fs-extra");
const os = require("os");
const { join } = require("path");
const sharp = require("sharp");
const toIco = require("to-ico");
const { v4: uuid } = require("uuid");
const { normalizeShape, applyShape } = require("../../../../build/thumbnail/image-mask");
const { parseCrop, orientedDimensions } = require("../../../../build/thumbnail/crop");

const ICO_SIZES = [16, 32, 48];
const PNG_SIZES = { png16: 16, png32: 32, appleTouch: 180 };
const MAX_PIXELS = 100 * 1000 * 1000;

function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function cropFor(metadata, crop) {
  const { width, height } = orientedDimensions(metadata);
  if (!width || !height || width * height > MAX_PIXELS) {
    throw badRequest("Please choose a reasonably sized image");
  }

  // No (or blank) crop means the largest centered square.
  const parsed = parseCrop(crop, width, height, "favicon");
  if (parsed) return parsed;

  const side = Math.min(width, height);
  return { left: Math.floor((width - side) / 2), top: Math.floor((height - side) / 2), width: side, height: side };
}

// `source`, when passed, is a sharp() instance already opened on sourcePath
// (e.g. by a profile-photo upload that also generates thumbnails from the
// same file) - cloning it avoids decoding the same file from disk twice.
async function generate(sourcePath, outputDirectory, crop, { source: input, shape: requestedShape } = {}) {
  const shape = normalizeShape(requestedShape);
  let metadata;
  try {
    metadata = await (input ? input.clone() : sharp(sourcePath, { pages: 1 })).metadata();
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
    const source = (input ? input.clone() : sharp(sourcePath, { pages: 1 })).rotate().ensureAlpha().extract(extraction).png();
    const render = async (size) => {
      const { data, info } = await source.clone().resize(size, size).png().toBuffer({ resolveWithObject: true });
      return applyShape(data, info.width, info.height, shape).png().toBuffer();
    };
    const icoBuffers = await Promise.all(ICO_SIZES.map(render));
    await fs.writeFile(join(workDirectory, `${prefix}.ico`), await toIco(icoBuffers));
    await Promise.all(Object.entries(PNG_SIZES).map(async ([name, size]) => {
      await fs.writeFile(join(workDirectory, `${prefix}-${size}.png`), await render(size));
    }));

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
