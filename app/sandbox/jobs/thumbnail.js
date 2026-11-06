// Makes the thumbnails of one image, one output per size, in the jail or
// in-process (see ../index.js). The args come from a process we treat as less
// trusted than this one, so they are checked here, not just in the caller:
//
//   { extension: ".jpg", animated: false, sizes: [{ size: 160, crop: false }],
//     accept: { formats: ["jpeg", "png"], minWidth: 64, minHeight: 64 } }
//
// meta is { source, thumbnails }: source is the image's { format, width,
// height }, as the metadata job reads them, and thumbnails is [{ width, height,
// format }], with outputs [Buffer], one per size. With accept, an image whose
// format isn't listed or which is smaller than the minimums gets no thumbnails
// (thumbnails is null, outputs empty), so a thumbnail candidate is checked and
// made in one jail, not two.

const sharp = require("sharp");
const { encode, isExtension } = require("./encode");

// Sharp seems to cache files based on their path and not the contents
// of the file at that path, so stale versions of a file in a blog's
// folder could come back.
sharp.cache(false);

const MAX_SIZES = 16;
const MAX_SIZE = 8192;
const MAX_FORMATS = 16;
const FORMAT = /^[a-z0-9]{1,16}$/;

function checkAccept(accept) {
  if (accept === undefined || accept === null) return null;
  if (typeof accept !== "object") throw new Error("invalid accept");
  const { formats, minWidth, minHeight } = accept;
  if (
    !Array.isArray(formats) ||
    !formats.length ||
    formats.length > MAX_FORMATS ||
    !formats.every(
      (format) => typeof format === "string" && FORMAT.test(format)
    )
  ) {
    throw new Error("invalid accept formats");
  }
  for (const n of [minWidth, minHeight]) {
    if (!Number.isInteger(n) || n < 0 || n > MAX_SIZE)
      throw new Error("invalid accept size");
  }
  return { formats: formats.slice(), minWidth, minHeight };
}

function accepted(source, accept) {
  if (!accept) return true;
  if (
    !source.format ||
    accept.formats.indexOf(source.format.toLowerCase()) === -1
  )
    return false;
  return source.width >= accept.minWidth && source.height >= accept.minHeight;
}

function check(args) {
  if (!args || typeof args !== "object") throw new Error("invalid arguments");

  if (!isExtension(args.extension)) throw new Error("invalid extension");

  if (typeof args.animated !== "boolean") throw new Error("invalid animated");

  if (
    !Array.isArray(args.sizes) ||
    !args.sizes.length ||
    args.sizes.length > MAX_SIZES
  ) {
    throw new Error("invalid sizes");
  }

  const sizes = args.sizes.map((options) => {
    if (!options || typeof options !== "object")
      throw new Error("invalid size");
    const size = options.size;
    if (!Number.isInteger(size) || size < 1 || size > MAX_SIZE)
      throw new Error("invalid size");
    if (typeof options.crop !== "boolean") throw new Error("invalid crop");
    return { size, crop: options.crop };
  });

  return {
    extension: args.extension,
    animated: args.animated,
    sizes,
    accept: checkAccept(args.accept),
  };
}

async function run(args, input) {
  const { extension, animated, sizes, accept } = check(args);

  // The first frame's size, as the metadata job reads it, animated or not
  const { format, width, height } = await sharp(input).metadata();
  const source = { format, width, height };
  if (!accepted(source, accept))
    return { meta: { source, thumbnails: null }, outputs: [] };

  const image = sharp(input, animated ? { animated: true } : undefined);

  const thumbnails = [];
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
          : {
              withoutEnlargement: true,
              fit: "cover",
              position: sharp.strategy.entropy,
            }
      );
    } else {
      transform.resize(size, size, { withoutEnlargement: true, fit: "inside" });
    }

    const { data, info } = await encode(transform, extension);
    thumbnails.push({
      width: info.width,
      height: info.height,
      format: info.format,
    });
    outputs.push(data);
  }

  return { meta: { source, thumbnails }, outputs };
}

module.exports = { run };
