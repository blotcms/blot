// Makes the thumbnails of one image, one output per size, in the jail or
// in-process (see ../index.js). The args come from a process we treat as less
// trusted than this one, so they are checked here, not just in the caller:
//
//   { extension: ".jpg", animated: false, sizes: [{ size: 160, crop: false }] }
//
// meta is [{ width, height, format }] and outputs is [Buffer], one per size.

const sharp = require("sharp");
const { encode, isExtension } = require("./encode");

// Sharp seems to cache files based on their path and not the contents
// of the file at that path, so stale versions of a file in a blog's
// folder could come back.
sharp.cache(false);

const MAX_SIZES = 16;
const MAX_SIZE = 8192;

function check(args) {
  if (!args || typeof args !== "object") throw new Error("invalid arguments");

  if (!isExtension(args.extension)) throw new Error("invalid extension");

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

  return { extension: args.extension, animated: args.animated, sizes };
}

async function run(args, input) {
  const { extension, animated, sizes } = check(args);
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

    const { data, info } = await encode(transform, extension);
    meta.push({ width: info.width, height: info.height, format: info.format });
    outputs.push(data);
  }

  return { meta, outputs };
}

module.exports = { run };
