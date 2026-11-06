// Reads an image's metadata. Runs in the jail (or in-process, see ../index.js).
// Nothing is returned that the image controls beyond these few fields.

const sharp = require("sharp");

sharp.cache(false);

async function run(args, input) {
  const { format, width, height, pages, orientation, hasAlpha } =
    await sharp(input).metadata();

  return {
    meta: { format, width, height, pages, orientation, hasAlpha },
    outputs: [],
  };
}

module.exports = { run };
