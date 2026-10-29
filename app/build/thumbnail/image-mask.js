const sharp = require("sharp");

// Geometry on a 1000 x 1000 grid, shared by the server-side mask (applied when
// a photo is saved) and the dashboard's shape picker icons. The dashboard's
// live previews clip with CSS instead, so each shape also has a `clip-path`
// (CLIP_PATHS); favicon.css repeats them as --mask-* and a spec keeps the two
// in step.
const MASK_POINTS = 360;
const CLIP_POINTS = 96;

const around = (n, point) => Array.from({ length: n }, (_, i) => point((Math.PI * 2 * i) / n));

// Scales a closed curve to fit the 1000 box, centered.
function fit(points) {
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const scale = 1000 / Math.max(maxX - minX, maxY - minY);
  return points.map(([x, y]) => [
    500 + (x - (minX + maxX) / 2) * scale,
    500 + (y - (minY + maxY) / 2) * scale,
  ]);
}

// A blob is a circle whose radius wobbles by a few harmonics: [lobes, strength, phase]
const blob = (harmonics) => (n) => fit(around(n, (angle) => {
  const radius = harmonics.reduce((sum, [lobes, strength, phase]) => sum + strength * Math.cos(lobes * angle + phase), 1);
  return [radius * Math.cos(angle), radius * Math.sin(angle)];
}));

const squircle = (n) => around(n, (angle) => [
  500 + 500 * Math.sign(Math.cos(angle)) * Math.sqrt(Math.abs(Math.cos(angle))),
  500 + 500 * Math.sign(Math.sin(angle)) * Math.sqrt(Math.abs(Math.sin(angle))),
]);

const CURVES = {
  squircle,
  blob: blob([[3, 0.1, 0.4], [2, 0.07, 2.1], [5, 0.04, 1.3]]),
  pebble: blob([[2, 0.09, 0.8], [3, 0.06, 3.0], [4, 0.03, 0.2]]),
  cloud: blob([[4, 0.14, 0.3], [2, 0.06, 1.9], [7, 0.05, 1.1]]),
};

const path = (points) => `${points.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(2)} ${y.toFixed(2)}`).join(" ")} Z`;
const clip = (points) => `polygon(${points.map(([x, y]) => `${(x / 10).toFixed(2)}% ${(y / 10).toFixed(2)}%`).join(", ")})`;

const SHAPES = [
  { value: "square", label: "Square", geometry: '<rect x="0" y="0" width="1000" height="1000"/>' },
  { value: "circle", label: "Circle", geometry: '<circle cx="500" cy="500" r="500"/>', clip: "circle(50%)" },
  { value: "rounded-square", label: "Rounded square", geometry: '<rect x="0" y="0" width="1000" height="1000" rx="200"/>', clip: "inset(0 round 20%)" },
  { value: "squircle", label: "Squircle", curve: CURVES.squircle },
  { value: "blob", label: "Blob", curve: CURVES.blob },
  { value: "pebble", label: "Pebble", curve: CURVES.pebble },
  { value: "cloud", label: "Cloud", curve: CURVES.cloud },
  { value: "arch", label: "Arch", geometry: '<path d="M0 1000V500A500 500 0 0 1 1000 500V1000Z"/>', clip: "inset(0 round 50% 50% 0 0)" },
].map((shape) => shape.curve
  ? { ...shape, geometry: `<path d="${path(shape.curve(MASK_POINTS))}"/>`, clip: clip(shape.curve(CLIP_POINTS)) }
  : shape);

const CLIP_PATHS = Object.fromEntries(SHAPES.filter((shape) => shape.clip).map((shape) => [shape.value, shape.clip]));

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

module.exports = { CLIP_PATHS, SHAPES, normalizeShape, applyShape, shapeIcon };
