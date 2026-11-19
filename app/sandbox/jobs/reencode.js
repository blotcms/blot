// Decodes an image fetched from a URL and encodes it again, so what the app
// keeps was written by libvips, not by the server. Shared by fetch-image.js and
// the "image" kind of fetch.js. Its pixel limits are measured against the
// 256 MiB cgroup these jobs run in (cgroupLimits in jail.js).

const sharp = require("sharp");
const { FetchError } = require("./fetching");

sharp.cache(false);

const MiB = 1024 * 1024;

// A re-encoded image can be larger than the one that came in
const MAX_OUTPUT_BYTES = 48 * MiB;

// What the callers' transforms take (app/build/plugins/image/optimize.js,
// app/build/thumbnail/config.js), each re-encoded in its own format. Never SVG:
// sharp can only rasterise it. Without optimised coding the JPEG encoder needs
// half the memory, for a file a fraction of a percent larger.
const ENCODERS = {
  jpeg: (image) => image.jpeg({ quality: 90, optimiseCoding: false }),
  png: (image) => image.png(),
  gif: (image) => image.gif(),
  webp: (image) => image.webp({ quality: 90 }),
};

// Pixels, every frame of an animation together, so the decode and encode fit
// in the job's cgroup (cgroupLimits in jail.js), measured. A 24 MP camera's
// photo fits. Lower for what has to be decoded whole: a progressive JPEG,
// whose decoder holds every coefficient, so fewer pixels unless its chroma is
// subsampled 4:2:0; an interlaced PNG; and WebP.
const MP = 1000 * 1000;
const MAX_PIXELS = {
  jpeg: 24 * MP,
  png: 24 * MP,
  gif: 24 * MP,
  webp: 12 * MP,
};
const MAX_PROGRESSIVE_PIXELS = {
  jpeg: (info) => (info.chromaSubsampling === "4:2:0" ? 24 * MP : 12 * MP),
  png: () => 12 * MP,
};

// The callers shrink every image to fit inside this anyway
// (app/build/plugins/image/resize.js), so the decoder can shrink as it reads
const MAX_DIMENSION = 3000;

function pixelLimit(info) {
  const progressive = MAX_PROGRESSIVE_PIXELS[info.format];
  return info.isProgressive && progressive
    ? progressive(info)
    : MAX_PIXELS[info.format];
}

// Decodes the body, which must be an image in one of ENCODERS' formats, and
// encodes it again: what comes out was written by libvips, not the server.
async function reencode(body) {
  let info;
  try {
    info = await sharp(body).metadata();
  } catch (e) {
    throw new FetchError("not an image");
  }

  const encoder = ENCODERS[info.format];
  if (!encoder) throw new FetchError("not a supported image format");

  const pages = info.pages || 1;
  const height = info.pageHeight || info.height;
  const limit = pixelLimit(info);
  if (!info.width || !height || info.width * height * pages > limit) {
    throw new FetchError("image is too large");
  }

  // Applying the EXIF orientation keeps a photo the right way up once the
  // re-encode has dropped its EXIF. An animation has none, and keeps its size.
  let image = sharp(body, {
    animated: pages > 1,
    limitInputPixels: limit,
  }).keepIccProfile();
  if (pages === 1) {
    image = image.rotate().resize(MAX_DIMENSION, MAX_DIMENSION, {
      fit: "inside",
      withoutEnlargement: true,
    });
  }

  let output;
  try {
    output = await encoder(image).toBuffer({ resolveWithObject: true });
  } catch (e) {
    throw new FetchError("image could not be decoded");
  }
  if (output.data.length > MAX_OUTPUT_BYTES)
    throw new FetchError("image is too large");

  return {
    data: output.data,
    format: output.info.format,
    width: output.info.width,
    height: output.info.pageHeight || output.info.height,
  };
}

module.exports = { reencode, MAX_DIMENSION, MAX_OUTPUT_BYTES };
