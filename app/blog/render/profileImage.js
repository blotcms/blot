const { CLIP_PATHS } = require("../../build/thumbnail/image-mask");

const RESPONSIVE = ["small", "medium", "large"];

// The profile_image local is saved with its thumbnails and a `mask` shape name.
// Templates show it as a responsive, CSS-clipped <img>, so expose the two
// values that are awkward to write in Mustache:
//
//   profile_image.srcset     "<small url> 160w, <medium url> 640w, ..."
//   profile_image.clip_path  a CSS clip-path for the mask ("" for none/square)
//
// Returns a copy: template locals are cached and shared between requests.
module.exports.locals = function profileImageLocals(locals) {
  const image = locals && locals.profile_image;
  if (!image || typeof image !== "object" || !image.thumbnails) return locals;

  // Originals are never enlarged, so a small photo's sizes can share a width
  const seen = new Set();
  const srcset = RESPONSIVE
    .map((name) => image.thumbnails[name])
    .filter((item) => item && item.url && item.width && !seen.has(item.width) && seen.add(item.width))
    .map((item) => `${item.url} ${item.width}w`)
    .join(", ");

  return {
    profile_image: { ...image, srcset, clip_path: CLIP_PATHS[image.mask] || "" },
  };
};
