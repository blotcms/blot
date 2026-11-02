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

function fitSquare(points) {
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const scaleX = 1000 / (maxX - minX);
  const scaleY = 1000 / (maxY - minY);
  return points.map(([x, y]) => [
    500 + (x - (minX + maxX) / 2) * scaleX,
    500 + (y - (minY + maxY) / 2) * scaleY,
  ]);
}

function rotateAndFitSquare(curve, degrees) {
  const angle = degrees * Math.PI / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return (n) => fitSquare(curve(n).map(([x, y]) => [
    500 + (x - 500) * cos - (y - 500) * sin,
    500 + (x - 500) * sin + (y - 500) * cos,
  ]));
}

// A blob is a circle whose radius wobbles by a few harmonics: [lobes, strength, phase]
const blob = (harmonics) => (n) => fit(around(n, (angle) => {
  const radius = harmonics.reduce((sum, [lobes, strength, phase]) => sum + strength * Math.cos(lobes * angle + phase), 1);
  return [radius * Math.cos(angle), radius * Math.sin(angle)];
}));

const mirrorBothAxes = (curve) => (n) => curve(n).map(([x, y]) => [1000 - x, 1000 - y]);
const mirrorHorizontally = (curve) => (n) => curve(n).map(([x, y]) => [1000 - x, y]);

const pebble = rotateAndFitSquare(blob([[2, 0.09, 0.8], [3, 0.06, 3.0], [4, 0.03, 0.2]]), 45);
const acorn = mirrorHorizontally(rotateAndFitSquare(blob([[2, 0.08, 0.5], [3, 0.055, 2.7], [4, 0.025, 0.1]]), 45));
const bean = rotateAndFitSquare(blob([[1, 0.12, 0.6], [2, 0.08, 1.5], [3, 0.04, 2.8]]), 45);
const sprig = mirrorBothAxes(blob([[3, 0.075, 0.4], [2, 0.045, 2.1], [5, 0.035, 1.3]]));
const daisy = (n) => fitSquare(around(n, (angle) => {
  const radius = 1 + 0.09 * Math.cos(6 * angle + 0.15) + 0.018 * Math.cos(12 * angle + 0.4);
  return [radius * Math.cos(angle), radius * Math.sin(angle)];
}));

const scallop = (n) => fitSquare(around(n, (angle) => {
  const radius = 1 + 0.035 * Math.cos(12 * angle) + 0.01 * Math.cos(6 * angle);
  return [radius * Math.cos(angle), radius * Math.sin(angle)];
}));

const starburst = (n) => fitSquare(around(n, (angle) => {
  const radius = 1 + 0.2 * Math.cos(5 * angle) + 0.025 * Math.cos(10 * angle);
  return [radius * Math.cos(angle), radius * Math.sin(angle)];
}));

const squircle = (n) => around(n, (angle) => [
  500 + 500 * Math.sign(Math.cos(angle)) * Math.sqrt(Math.abs(Math.cos(angle))),
  500 + 500 * Math.sign(Math.sin(angle)) * Math.sqrt(Math.abs(Math.sin(angle))),
]);

const CURVES = {
  squircle,
  blob: blob([[3, 0.1, 0.4], [2, 0.07, 2.1], [5, 0.04, 1.3]]),
  sprig,
  pebble,
  cloud: blob([[4, 0.14, 0.3], [2, 0.06, 1.9], [7, 0.05, 1.1]]),
  daisy,
  flower: blob([[5, 0.22, 0.1], [10, 0.04, 0.6]]),
  starburst,
  spiky: blob([[7, 0.34, 0], [14, 0.04, 0.15]]),
  sunburst: blob([[9, 0.28, 0.08], [18, 0.035, 0.1]]),
  scallop,
  "wavy-star": blob([[5, 0.24, 0.05], [10, 0.12, 0.2]]),
  splash: blob([[3, 0.25, 0.15], [6, 0.09, 0.7], [9, 0.035, 0.2]]),
  amoeba: blob([[2, 0.15, 0.8], [3, 0.12, 2.4], [5, 0.08, 0.3]]),
  petal: blob([[4, 0.17, 0.3], [8, 0.08, 0.9], [3, 0.05, 1.1]]),
};

const ORGANIC_SHAPES = [
  "blob", "moss-bud", "lichen", "pebble", "acorn", "bean", "cloud",
  "daisy", "starburst", "scallop", "petal",
];

const path = (points) => `${points.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(2)} ${y.toFixed(2)}`).join(" ")} Z`;
const clip = (points) => `polygon(${points.map(([x, y]) => `${(x / 10).toFixed(2)}% ${(y / 10).toFixed(2)}%`).join(", ")})`;

const SHAPES = [
  { value: "circle", label: "Circle", geometry: '<circle cx="500" cy="500" r="500"/>', clip: "circle(50%)" },
  { value: "square", label: "Square", geometry: '<rect x="0" y="0" width="1000" height="1000"/>' },
  { value: "rounded-square", label: "Rounded square", geometry: '<rect x="0" y="0" width="1000" height="1000" rx="200"/>', clip: "inset(0 round 20%)" },
  { value: "squircle", label: "Squircle", curve: CURVES.squircle },
  { value: "blob", label: "Blob", name: "Moss", curve: CURVES.blob },
  { value: "moss-bud", label: "Moss bud", name: "Sprig", curve: CURVES.sprig },
  { value: "lichen", label: "Lichen", name: "Lichen", curve: blob([[3, 0.11, 1.0], [6, 0.04, 0.2], [2, 0.05, 2.3]]) },
  { value: "pebble", label: "Pebble", name: "Pip", curve: CURVES.pebble },
  { value: "acorn", label: "Acorn", name: "Acorn", curve: acorn },
  { value: "bean", label: "Bean", name: "Bean", curve: bean },
  { value: "cloud", label: "Cloud", name: "Nimbus", curve: CURVES.cloud },
  { value: "daisy", label: "Daisy", name: "Daisy", curve: CURVES.daisy },
  { value: "flower", label: "Flower", name: "Mallow", curve: CURVES.flower },
  { value: "starburst", label: "Starburst", name: "Comet", curve: CURVES.starburst },
  { value: "spiky", label: "Spiky star", name: "Thorn", curve: CURVES.spiky },
  { value: "sunburst", label: "Sunburst", name: "Sol", curve: CURVES.sunburst },
  { value: "scallop", label: "Scallop", name: "Shell", curve: CURVES.scallop },
  { value: "wavy-star", label: "Wavy star", name: "Ziggy", curve: CURVES["wavy-star"] },
  { value: "splash", label: "Splash", name: "Puddle", curve: CURVES.splash },
  { value: "amoeba", label: "Amoeba", name: "Gloop", curve: CURVES.amoeba },
  { value: "petal", label: "Petal", name: "Pollen", curve: CURVES.petal },
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

module.exports = { CLIP_PATHS, SHAPES, ORGANIC_SHAPES, normalizeShape, applyShape, shapeIcon };
