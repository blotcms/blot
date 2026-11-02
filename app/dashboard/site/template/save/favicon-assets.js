const fs = require("fs-extra");
const os = require("os");
const { join } = require("path");
const { v4: uuid } = require("uuid");
const sandbox = require("sandbox");
const { normalizeShape } = require("sandbox/jobs/image-mask");
const { parseCrop, orientedDimensions } = require("sandbox/jobs/crop");

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

// The image is decoded and the set made in the sandbox (app/sandbox/jobs/favicon.js)
async function generate(sourcePath, outputDirectory, crop, { shape: requestedShape } = {}) {
  const shape = normalizeShape(requestedShape);
  let metadata;
  try {
    metadata = (await sandbox.run("metadata", {}, { path: sourcePath })).meta;
  } catch (_) {
    throw badRequest("Please choose an image for your favicon");
  }

  const extraction = cropFor(metadata, crop);
  const { outputs } = await sandbox.run(
    "favicon",
    { extract: extraction, shape, ico: ICO_SIZES, png: Object.values(PNG_SIZES) },
    { path: sourcePath }
  );

  const id = uuid();
  const prefix = `favicon-${id}`;
  const files = [[`${prefix}.ico`, outputs[0]]].concat(
    Object.values(PNG_SIZES).map((size, i) => [`${prefix}-${size}.png`, outputs[i + 1]])
  );
  const workDirectory = await fs.mkdtemp(join(os.tmpdir(), "blot-favicon-"));

  try {
    await Promise.all(files.map(([name, data]) => fs.writeFile(join(workDirectory, name), data)));
    await fs.ensureDir(outputDirectory);
    await Promise.all(files.map(([name]) => fs.move(join(workDirectory, name), join(outputDirectory, name))));
    return { id, prefix, crop: extraction };
  } finally {
    await fs.remove(workDirectory);
  }
}

module.exports = { generate, cropFor, ICO_SIZES, PNG_SIZES };
