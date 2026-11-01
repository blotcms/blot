// Shrinks an image to fit inside max by max, keeping its profile and applying
// its rotation, in the jail or in-process (see ../index.js). Args:
// { max: 3000, extension: ".jpg" }. meta is sharp's info for the output.

const sharp = require("sharp");
const { encode, isExtension } = require("./encode");

sharp.cache(false);

const MAX = 16384;

async function run(args, input) {
  const max = args && args.max;
  if (!Number.isInteger(max) || max < 1 || max > MAX) throw new Error("invalid max");
  if (!isExtension(args.extension)) throw new Error("invalid extension");

  const { data, info } = await encode(
    sharp(input)
      .keepIccProfile()
      .rotate()
      .resize(max, max, { withoutEnlargement: true, fit: "inside" }),
    args.extension
  );

  const { format, width, height, channels, premultiplied, size } = info;
  return {
    meta: { format, width, height, channels, premultiplied, size },
    outputs: [data],
  };
}

module.exports = { run };
