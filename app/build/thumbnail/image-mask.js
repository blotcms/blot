const sharp = require("sharp");

// Geometry on a 1000 x 1000 grid, shared by the server-side mask, the
// dashboard's shape picker icons and (as `clip-path`s in favicon.css) the
// dashboard previews. Keep favicon.css's --mask-* values in step.
const SQUIRCLE_POINTS = 512;
const squirclePath = () => {
  const points = [];
  for (let i = 0; i < SQUIRCLE_POINTS; i += 1) {
    const angle = (Math.PI * 2 * i) / SQUIRCLE_POINTS;
    const x = 500 + 500 * Math.sign(Math.cos(angle)) * Math.sqrt(Math.abs(Math.cos(angle)));
    const y = 500 + 500 * Math.sign(Math.sin(angle)) * Math.sqrt(Math.abs(Math.sin(angle)));
    points.push(`${i === 0 ? "M" : "L"}${x.toFixed(2)} ${y.toFixed(2)}`);
  }
  return `${points.join(" ")} Z`;
};

const SHAPES = [
  { value: "square", label: "Square", geometry: '<rect x="0" y="0" width="1000" height="1000"/>' },
  { value: "circle", label: "Circle", geometry: '<circle cx="500" cy="500" r="500"/>' },
  { value: "rounded-square", label: "Rounded square", geometry: '<rect x="0" y="0" width="1000" height="1000" rx="200"/>' },
  { value: "squircle", label: "Squircle", geometry: `<path d="${squirclePath()}"/>` },
  { value: "hexagon", label: "Hexagon", geometry: '<path d="M500 0 933 250 933 750 500 1000 67 750 67 250Z"/>' },
  { value: "arch", label: "Arch", geometry: '<path d="M0 1000V500A500 500 0 0 1 1000 500V1000Z"/>' },
];
const BY_VALUE = new Map(SHAPES.map((shape) => [shape.value, shape]));

function normalizeShape(shape) {
  const normalized = shape || "square";
  if (!BY_VALUE.has(normalized)) {
    const error = new Error("Please choose a supported photo shape");
    error.status = 400;
    throw error;
  }
  return normalized;
}

function shapeMask(width, height, shape) {
  return Buffer.from(
    `<svg width="${width}" height="${height}" viewBox="0 0 1000 1000" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg"><g fill="white">${BY_VALUE.get(normalizeShape(shape)).geometry}</g></svg>`
  );
}

// Clears everything outside `shape` from an encoded image, returning a sharp
// pipeline (square images are returned untouched).
function applyShape(data, width, height, shape) {
  const image = sharp(data);
  if (normalizeShape(shape) === "square") return image;
  return image.ensureAlpha().composite([{ input: shapeMask(width, height, shape), blend: "dest-in" }]);
}

// Outline icon for the shape picker; stroke and size come from the page CSS.
function shapeIcon(shape) {
  return `<svg viewBox="-40 -40 1080 1080" aria-hidden="true">${BY_VALUE.get(shape).geometry}</svg>`;
}

module.exports = { SHAPES, normalizeShape, applyShape, shapeIcon };
