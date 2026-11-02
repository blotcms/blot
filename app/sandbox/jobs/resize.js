// Shrinks an image to fit inside max by max, keeping its profile and applying
// its rotation, in the jail or in-process (see ../index.js). Args: { max: 3000 }.
// The output keeps the input's format, whatever the file was called; meta is
// sharp's info for it.

const sharp = require("sharp");
const { encode } = require("./encode");

sharp.cache(false);

const MAX = 16384;

async function run(args, input) {
  const max = args && args.max;
  if (!Number.isInteger(max) || max < 1 || max > MAX) throw new Error("invalid max");

  const { data, info } = await encode(
    sharp(input)
      .keepIccProfile()
      .rotate()
      .resize(max, max, { withoutEnlargement: true, fit: "inside" }),
    ""
  );

  const { format, width, height, channels, premultiplied, size } = info;
  return {
    meta: { format, width, height, channels, premultiplied, size },
    outputs: [data],
  };
}

module.exports = { run };
