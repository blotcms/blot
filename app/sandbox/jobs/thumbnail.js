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
//
// An animated image costs every frame of every size, so it has a budget
// (BUDGET, which a spec may lower with args.budget). Past it, the thumbnails
// are of the first frame, and meta.firstFrame is true. Within it, a GIF
// size that comes out the GIF's own size is its bytes as they are, and the
// other sizes are made largest first, each from the smallest one already made
// that covers it.

const sharp = require("sharp");
const { encode, isExtension } = require("./encode");

// Sharp seems to cache files based on their path and not the contents
// of the file at that path, so stale versions of a file in a blog's
// folder could come back.
sharp.cache(false);

const MAX_SIZES = 16;

// The most pixels an animated image's thumbnails may encode, every frame of
// every size counted (a size passed through as is costs nothing). Past it the
// thumbnails are of the first frame. About 10s in a production jail, half of
// what the build waits (app/build/thumbnail/create.js).
const BUDGET = 50 * 1000 * 1000;

// sharp's limitInputPixels, which counts every frame of an animated image
const MAX_INPUT_PIXELS = 268402689;

// The largest animated GIF passed through as is. Two sizes may both be the
// image's own size, and the job's output is capped (proxy/unit/sandbox/jail.js).
const PASS_THROUGH_BYTES = 8 * 1024 * 1024;
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

  let budget = BUDGET;
  if (args.budget !== undefined) {
    if (
      !Number.isInteger(args.budget) ||
      args.budget < 1 ||
      args.budget > BUDGET
    )
      throw new Error("invalid budget");
    budget = args.budget;
  }

  return {
    extension: args.extension,
    animated: args.animated,
    sizes,
    accept: checkAccept(args.accept),
    budget,
  };
}

// sharp reports the height of an animated output as all its frames, one on top
// of the other
function frameHeight(info) {
  return info.pageHeight || info.height;
}

// The size sharp makes when it fits width x height into size, never enlarging,
// inside the square or covering it
function fitted(width, height, { size, crop }) {
  if (crop)
    return { width: Math.min(size, width), height: Math.min(size, height) };
  const scale = Math.min(1, size / width, size / height);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

// One size of a still image, or of an animated image's first frame
function still(input, { size, crop }) {
  const transform = sharp(input).keepIccProfile().rotate();
  return crop
    ? transform.resize(size, size, {
        withoutEnlargement: true,
        fit: "cover",
        position: sharp.strategy.entropy,
      })
    : transform.resize(size, size, { withoutEnlargement: true, fit: "inside" });
}

// One size of an animated image, every frame. Animated images have never kept
// their profile, nor had their crop weighted by entropy.
function moving(input, { size, crop }) {
  return sharp(input, { animated: true })
    .rotate()
    .resize(size, size, {
      withoutEnlargement: true,
      fit: crop ? "cover" : "inside",
    });
}

async function run(args, input) {
  const { extension, animated, sizes, accept, budget } = check(args);

  // The first frame's size, as the metadata job reads it, animated or not
  const { format, width, height, pages } = await sharp(input).metadata();
  const source = { format, width, height };
  if (!accepted(source, accept))
    return { meta: { source, thumbnails: null }, outputs: [] };

  const frames = animated ? pages || 1 : 1;
  const plan = sizes.map((options) => {
    const out = fitted(width, height, options);
    // An animated GIF that comes out the size it is needs no re-encoding: its
    // bytes are the blog's own file, which the blog's folder already serves
    const same =
      animated &&
      !options.crop &&
      format === "gif" &&
      extension === ".gif" &&
      out.width === width &&
      out.height === height &&
      input.length <= PASS_THROUGH_BYTES;
    return { ...options, out, same };
  });

  // Encoding every frame is what costs: about 5M pixels a second in a
  // production jail. Past the budget, or past what sharp decodes, the
  // thumbnails are of the first frame.
  const encoded = plan
    .filter((p) => !p.same)
    .reduce((n, p) => n + p.out.width * p.out.height * frames, 0);
  const firstFrame =
    animated &&
    frames > 1 &&
    (encoded > budget || width * height * frames > MAX_INPUT_PIXELS);

  const results = new Array(plan.length);

  if (!animated || firstFrame) {
    // One at a time, to keep the memory of the jail down
    for (let i = 0; i < plan.length; i++)
      results[i] = await encode(still(input, plan[i]), extension);
  } else {
    // Largest first, so a smaller size can be made from a larger one's
    // frames instead of the source's: resizing every frame costs too
    const order = plan
      .map((p, i) => i)
      .sort(
        (a, b) =>
          plan[b].out.width * plan[b].out.height -
          plan[a].out.width * plan[a].out.height
      );
    const made = new Map();
    const larger = [];
    for (const i of order) {
      const p = plan[i];
      if (p.same) {
        results[i] = {
          data: input,
          info: { width, height, format: "gif" },
        };
        continue;
      }
      const key = `${p.size}:${p.crop}`;
      if (made.has(key)) {
        results[i] = made.get(key);
        continue;
      }
      // The smallest uncropped thumbnail made so far that covers this one
      const from = larger
        .filter(
          (l) =>
            l.info.width >= p.out.width && frameHeight(l.info) >= p.out.height
        )
        .reduce((a, b) => (!a || b.info.width < a.info.width ? b : a), null);
      const result = await encode(
        moving(from ? from.data : input, p),
        extension
      );
      made.set(key, result);
      if (!p.crop) larger.push(result);
      results[i] = result;
    }
  }

  const meta = {
    source,
    thumbnails: results.map(({ info }) => ({
      width: info.width,
      height: frameHeight(info),
      format: info.format,
    })),
  };
  if (firstFrame) meta.firstFrame = true;
  return { meta, outputs: results.map(({ data }) => data) };
}

module.exports = { run, BUDGET };
