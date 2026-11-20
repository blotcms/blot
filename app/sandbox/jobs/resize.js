// Shrinks an image to fit inside max by max, keeping its profile and applying
// its rotation, in the jail or in-process (see ../index.js). Args: { max: 3000 }.
// The output keeps the input's format, whatever the file was called; meta is
// sharp's info for it.
//
// With args.thumbnail (the thumbnail job's arguments, see ./thumbnail.js) it
// also makes the thumbnails of the image it has just encoded, from those very
// bytes, which is what the thumbnail job would be given: meta.thumbnail is the
// thumbnail job's meta and outputs[1..] its outputs, so a post's first image
// needs one jail, not two. If the thumbnails can't be made the resize still
// succeeds, with no meta.thumbnail, and the caller makes them as it always did.

const sharp = require("sharp");
const { encode, MAX_INPUT_PIXELS } = require("./encode");
const thumbnail = require("./thumbnail");

sharp.cache(false);

const MAX = 16384;

// The most pixels of resized image the thumbnails are made from here, so the
// decode (4 bytes a pixel) comes to a few tens of MiB on top of the input. The
// plugin's 3000px squares are 9M at most; a larger max just gets no thumbnails.
const MAX_THUMBNAIL_PIXELS = 16 * 1000 * 1000;

// And of bytes, so the reply (the image and four thumbnails, at most about
// 12 MiB between them) stays well within the 64 MiB the broker allows a resize
const MAX_THUMBNAIL_BYTES = 24 * 1024 * 1024;

async function run(args, input) {
  const max = args && args.max;
  if (!Number.isInteger(max) || max < 1 || max > MAX)
    throw new Error("invalid max");

  const { data, info } = await encode(
    sharp(input, { limitInputPixels: MAX_INPUT_PIXELS })
      .keepIccProfile()
      .rotate()
      .resize(max, max, { withoutEnlargement: true, fit: "inside" }),
    ""
  );

  const { format, width, height, channels, premultiplied, size } = info;
  const meta = { format, width, height, channels, premultiplied, size };
  const outputs = [data];

  if (
    args.thumbnail !== undefined &&
    width * height <= MAX_THUMBNAIL_PIXELS &&
    data.length <= MAX_THUMBNAIL_BYTES
  ) {
    try {
      const made = await thumbnail.run(args.thumbnail, data);
      meta.thumbnail = made.meta;
      outputs.push(...made.outputs);
    } catch (err) {
      // Left to the thumbnail job, which reports it as it always did
    }
  }

  return { meta, outputs };
}

module.exports = { run };
