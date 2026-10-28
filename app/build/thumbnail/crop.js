// Normalized crops arrive from the dashboard as fractions of the oriented
// image. A crop is either a rectangle {x, y, width, height} or a square
// {x, y, size}, where size is a fraction of the shorter edge (the favicon
// cropper). Blank or missing coordinates mean "no crop" and return null.

// Browsers submit unrounded floats, so x + width can land a few ulps past 1
// when a box is dragged to an edge.
const EPSILON = 1e-6;

function invalid(message) { const error = new Error(message); error.status = 400; return error; }
const blank = (v) => v === "" || v == null;

// Dimensions as the browser (and the cropper) sees them, i.e. after any EXIF
// orientation has been applied. Orientations 5-8 rotate the image a quarter
// turn, so width and height are swapped relative to the stored pixels.
function orientedDimensions(metadata) {
  const swap = metadata.orientation >= 5 && metadata.orientation <= 8;
  return { width: swap ? metadata.height : metadata.width, height: swap ? metadata.width : metadata.height };
}

function parseCrop(value, width, height, label = "image") {
  if (!value || blank(value.x) || blank(value.y)) return null;
  const square = !blank(value.size);
  if (!square && (blank(value.width) || blank(value.height))) return null;

  const x = Number(value.x);
  const y = Number(value.y);
  const w = Number(square ? value.size : value.width);
  const h = Number(square ? value.size : value.height);
  if (
    ![x, y, w, h].every(Number.isFinite) ||
    x < 0 || y < 0 || w <= 0 || h <= 0 ||
    x > 1 || y > 1 || w > 1 || h > 1 ||
    (!square && (x + w > 1 + EPSILON || y + h > 1 + EPSILON))
  ) {
    throw invalid(`The selected ${label} crop is invalid`);
  }

  const side = Math.floor(w * Math.min(width, height));
  const extraction = {
    left: Math.floor(x * width),
    top: Math.floor(y * height),
    width: square ? side : Math.floor(w * width),
    height: square ? side : Math.floor(h * height),
  };
  // Clamp float overshoot so the extraction never leaves the image.
  extraction.width = Math.min(extraction.width, width - extraction.left);
  extraction.height = Math.min(extraction.height, height - extraction.top);
  if (square && extraction.width < side) throw invalid(`The selected ${label} crop is outside the image`);
  if (extraction.width < 1 || extraction.height < 1) throw invalid(`The selected ${label} crop is outside the image`);
  return extraction;
}

module.exports = { parseCrop, orientedDimensions };
