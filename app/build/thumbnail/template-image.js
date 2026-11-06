const fs = require("fs-extra");
const os = require("os");
const { join } = require("path");
const { v4: uuid } = require("uuid");
const sandbox = require("sandbox");
const { MAX_PIXELS, SOURCE_MAX } = require("sandbox/jobs/template-image");
const { THUMBNAILS } = require("./config");
const { normalizeShape } = require("sandbox/jobs/image-mask");
const {
  parseCrop,
  normalizedCrop,
  orientedDimensions: dimensions,
} = require("sandbox/jobs/crop");

const SUPPORTED = new Set([
  "jpeg",
  "png",
  "webp",
  "gif",
  "tiff",
  "avif",
  "svg",
]);
const SIZES = Object.values(THUMBNAILS).map(({ size, crop }) => ({
  size,
  crop: !!crop,
}));

function invalid(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

// The pixel work runs in the sandbox (app/sandbox/jobs/template-image.js). This
// side keeps the checks that give the user a message: the jail's errors carry
// none.
//
// The check decodes a small derivative as well as the header, so corrupt pixel
// data is rejected before a shared template is forked.
async function check(sourcePath) {
  let metadata;
  try {
    metadata = (
      await sandbox.run("template-image", { op: "check" }, { path: sourcePath })
    ).meta;
  } catch (_) {
    throw invalid("Please choose a valid image");
  }
  const oriented = dimensions(metadata);
  if (
    !SUPPORTED.has(metadata.format) ||
    !oriented.width ||
    !oriented.height ||
    oriented.width * oriented.height > MAX_PIXELS
  ) {
    throw invalid("Please choose a supported image under 100 megapixels");
  }
  return {
    width: oriented.width,
    height: oriented.height,
    format: metadata.format,
  };
}

async function validate(sourcePath, crop, shape) {
  normalizeShape(shape);
  const checked = await check(sourcePath);
  parseCrop(crop, checked.width, checked.height);
  return checked;
}

// Writes the job's outputs to the output directory under their names, removing
// what it wrote if any write fails
async function publish(outputDirectory, files) {
  const temporary = await fs.mkdtemp(join(os.tmpdir(), "blot-template-image-"));
  const published = [];
  try {
    for (const [name, data] of files)
      await fs.writeFile(join(temporary, name), data);
    await fs.ensureDir(outputDirectory);
    for (const [name] of files) {
      const destination = join(outputDirectory, name);
      await fs.move(join(temporary, name), destination);
      published.push(destination);
    }
  } catch (error) {
    await Promise.all(published.map((path) => fs.remove(path).catch(() => {})));
    throw error;
  } finally {
    await fs.remove(temporary);
  }
}

function thumbnailResults(names, meta) {
  const results = {};
  Object.keys(THUMBNAILS).forEach((name, i) => {
    results[name] = {
      width: meta[i].width,
      height: meta[i].height,
      name: names[name],
    };
  });
  return results;
}

// Decode one page deliberately: animated uploads have a deterministic first
// frame. This mirrors the existing thumbnail pipeline's non-animated output.
//
// With `editable`, the stored original is the whole image (shrunk to SOURCE_MAX)
// and the crop only applies to the thumbnails, so the crop can be changed later
// with regenerate(). Otherwise the original is the cropped image. Every
// thumbnail is cut to `shape`, so templates can use any of them as is.
async function generate(
  sourcePath,
  outputDirectory,
  crop,
  { shape: requestedShape, editable } = {}
) {
  const shape = normalizeShape(requestedShape);
  const checked = await check(sourcePath);
  parseCrop(crop, checked.width, checked.height);

  const { meta, outputs } = await sandbox.run(
    "template-image",
    {
      op: "generate",
      crop: crop || null,
      shape,
      editable: !!editable,
      sizes: SIZES,
    },
    { path: sourcePath }
  );

  const prefix = `image-${uuid()}`;
  const names = { original: `${prefix}-original.webp` };
  Object.keys(THUMBNAILS).forEach((name) => {
    names[name] = `${prefix}-${name}.webp`;
  });
  await publish(
    outputDirectory,
    [names.original]
      .concat(Object.keys(THUMBNAILS).map((name) => names[name]))
      .map((name, i) => [name, outputs[i]])
  );

  return {
    prefix,
    original: {
      name: names.original,
      width: meta[0].width,
      height: meta[0].height,
    },
    crop: editable ? normalizedCrop(crop) : null,
    thumbnails: thumbnailResults(names, meta.slice(1)),
  };
}

// Re-renders the thumbnails of an editable image from its stored source, for
// when its crop or shape changes without a new upload.
async function regenerate(sourceBuffer, outputDirectory, crop, requestedShape) {
  const shape = normalizeShape(requestedShape);
  const { meta, outputs } = await sandbox.run(
    "template-image",
    { op: "regenerate", crop: crop || null, shape, sizes: SIZES },
    sourceBuffer
  );
  const prefix = `image-${uuid()}`;
  const names = {};
  Object.keys(THUMBNAILS).forEach((name) => {
    names[name] = `${prefix}-${name}.webp`;
  });
  await publish(
    outputDirectory,
    Object.keys(THUMBNAILS).map((name, i) => [names[name], outputs[i]])
  );
  return { thumbnails: thumbnailResults(names, meta) };
}

module.exports = {
  generate,
  regenerate,
  validate,
  MAX_PIXELS,
  SOURCE_MAX,
  parseCrop,
  normalizeShape,
};
