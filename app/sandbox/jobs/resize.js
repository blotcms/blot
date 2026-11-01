// Shrinks an image to fit inside max by max, keeping its profile and applying
// its rotation, in the jail or in-process (see ../index.js). Args: { max: 3000 }.
// The output is in the input's format; meta is sharp's info for it.

const sharp = require("sharp");

sharp.cache(false);
sharp.concurrency(1);

const MAX = 16384;

async function run(args, input) {
  const max = args && args.max;
  if (!Number.isInteger(max) || max < 1 || max > MAX) throw new Error("invalid max");

  const { data, info } = await sharp(input)
    .keepIccProfile()
    .rotate()
    .resize(max, max, { withoutEnlargement: true, fit: "inside" })
    .toBuffer({ resolveWithObject: true });

  const { format, width, height, channels, premultiplied, size } = info;
  return {
    meta: { format, width, height, channels, premultiplied, size },
    outputs: [data],
  };
}

module.exports = { run };
