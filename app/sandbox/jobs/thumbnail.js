// Makes the thumbnails of one image, one output per size, in the jail or
// in-process (see ../index.js). The args come from a process we treat as less
// trusted than this one, so they are checked here, not just in the caller:
//
//   { extension: ".jpg", animated: false, sizes: [{ size: 160, crop: false }] }
//
// meta is [{ width, height, format }] and outputs is [Buffer], one per size.

const sharp = require("sharp");

// Sharp seems to cache files based on their path and not the contents
// of the file at that path, so stale versions of a file in a blog's
// folder could come back.
sharp.cache(false);
sharp.concurrency(1);

// What toFile used to infer from the extension of the output path
const FORMATS = {
  ".jpg": "jpeg",
  ".jpeg": "jpeg",
  ".png": "png",
  ".webp": "webp",
  ".gif": "gif",
};

const MAX_SIZES = 16;
const MAX_SIZE = 8192;

function check(args) {
  if (!args || typeof args !== "object") throw new Error("invalid arguments");

  const format = Object.prototype.hasOwnProperty.call(FORMATS, args.extension)
    ? FORMATS[args.extension]
    : null;
  if (!format) throw new Error("unsupported extension");

  if (typeof args.animated !== "boolean") throw new Error("invalid animated");

  if (!Array.isArray(args.sizes) || !args.sizes.length || args.sizes.length > MAX_SIZES) {
    throw new Error("invalid sizes");
  }

  const sizes = args.sizes.map((options) => {
    if (!options || typeof options !== "object") throw new Error("invalid size");
    const size = options.size;
    if (!Number.isInteger(size) || size < 1 || size > MAX_SIZE) throw new Error("invalid size");
    if (typeof options.crop !== "boolean") throw new Error("invalid crop");
    return { size, crop: options.crop };
  });

  return { format, animated: args.animated, sizes };
}

async function run(args, input) {
  const { format, animated, sizes } = check(args);
  const image = sharp(input, animated ? { animated: true } : undefined);

  const meta = [];
  const outputs = [];

  // One at a time, to keep the memory of the jail down
  for (const { size, crop } of sizes) {
    let transform = image.clone();

    // Animated images have never kept their profile
    if (!animated) transform = transform.keepIccProfile();
    transform = transform.rotate();

    if (crop) {
      transform.resize(
        size,
        size,
        animated
          ? { withoutEnlargement: true, fit: "cover" }
          : { withoutEnlargement: true, fit: "cover", position: sharp.strategy.entropy }
      );
    } else {
      transform.resize(size, size, { withoutEnlargement: true, fit: "inside" });
    }

    const { data, info } = await transform.toFormat(format).toBuffer({ resolveWithObject: true });
    meta.push({ width: info.width, height: info.height, format: info.format });
    outputs.push(data);
  }

  return { meta, outputs };
}

module.exports = { run };
