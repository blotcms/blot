"use strict";

/**
 * Generates a small, fixed-size (~20-30 file) pool of genuinely small,
 * genuinely valid media files - JPEG/PNG photos, short animated GIFs, and a
 * couple of SVGs - entirely dynamically with `sharp` (already a Blot
 * dependency) plus ImageMagick's `convert` for assembling GIF frames, if
 * available.
 *
 * Nothing here is committed to git: the pool is regenerated fresh into a
 * working directory every time a benchmark run needs media (see
 * ensureMediaPool below), deterministically (fixed seed) so its contents are
 * reproducible run to run without needing to check anything in.
 *
 * The workload generator (spec/util/workload.js) hard-links posts to files
 * in this pool - see build-render.spec.js for why hard link and not symlink.
 */
const path = require("path");
const fs = require("fs");
const os = require("os");
const { execFileSync } = require("child_process");
const sharp = require("sharp");
const seedrandom = require("seedrandom");

const PALETTES = [
  [
    { r: 235, g: 87, b: 87 },
    { r: 242, g: 201, b: 76 },
    { r: 87, g: 176, b: 235 },
  ],
  [
    { r: 39, g: 174, b: 96 },
    { r: 242, g: 153, b: 74 },
    { r: 155, g: 89, b: 182 },
  ],
  [
    { r: 41, g: 128, b: 185 },
    { r: 44, g: 62, b: 80 },
    { r: 236, g: 240, b: 241 },
  ],
];

function randChoice(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

function gradientBuffer(width, height, colorA, colorB, noiseSeed) {
  const buffer = Buffer.alloc(width * height * 3);
  const localRng = seedrandom(String(noiseSeed));

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const t = (x / width + y / height) / 2;
      const noise = (localRng() - 0.5) * 6;

      const i = (y * width + x) * 3;
      buffer[i] = clamp(colorA.r + (colorB.r - colorA.r) * t + noise);
      buffer[i + 1] = clamp(colorA.g + (colorB.g - colorA.g) * t + noise);
      buffer[i + 2] = clamp(colorA.b + (colorB.b - colorA.b) * t + noise);
    }
  }

  return buffer;
}

function clamp(value) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

async function generatePhotos(outDir, rng) {
  const sizes = [
    [400, 300],
    [800, 600],
    [1024, 768],
    [1280, 800],
    [1600, 1200],
    [640, 480],
    [960, 640],
    [1200, 900],
    [500, 500],
    [720, 480],
    [900, 1200],
    [1440, 900],
    [640, 960],
    [1080, 1080],
    [1600, 900],
    [480, 640],
    [1024, 1024],
    [768, 1024],
  ];

  const written = [];

  for (let i = 0; i < sizes.length; i++) {
    const [width, height] = sizes[i];
    const palette = randChoice(rng, PALETTES);
    const colorA = randChoice(rng, palette);
    const colorB = randChoice(rng, palette);
    const raw = gradientBuffer(width, height, colorA, colorB, `photo-${i}`);

    const image = sharp(raw, { raw: { width, height, channels: 3 } });
    const isJpeg = i % 2 === 0;
    const ext = isJpeg ? "jpg" : "png";
    const outPath = path.join(outDir, `photo-${i}-${width}x${height}.${ext}`);

    if (isJpeg) {
      await image.jpeg({ quality: 65, mozjpeg: true }).toFile(outPath);
    } else {
      await image
        .png({ compressionLevel: 9, palette: true, colors: 48, quality: 60 })
        .toFile(outPath);
    }

    written.push(outPath);
  }

  return written;
}

async function generateGifs(outDir, rng) {
  const gifSpecs = [
    { name: "anim-0-loader", width: 160, height: 120, frames: 6 },
    { name: "anim-1-banner", width: 320, height: 180, frames: 4 },
    { name: "anim-2-icon", width: 96, height: 96, frames: 8 },
    { name: "anim-3-strip", width: 240, height: 160, frames: 5 },
  ];

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "blot-bench-gif-"));
  const written = [];

  let hasConvert = true;
  try {
    execFileSync("convert", ["-version"], { stdio: "ignore" });
  } catch (err) {
    hasConvert = false;
  }

  for (const spec of gifSpecs) {
    const framePaths = [];
    const palette = randChoice(rng, PALETTES);

    for (let f = 0; f < spec.frames; f++) {
      const colorA = randChoice(rng, palette);
      const colorB = randChoice(rng, palette);
      const raw = gradientBuffer(
        spec.width,
        spec.height,
        colorA,
        colorB,
        `${spec.name}-frame-${f}`
      );

      const framePath = path.join(tmpDir, `${spec.name}-frame-${f}.png`);
      await sharp(raw, {
        raw: { width: spec.width, height: spec.height, channels: 3 },
      })
        .png()
        .toFile(framePath);
      framePaths.push(framePath);
    }

    const outPath = path.join(outDir, `${spec.name}.gif`);

    if (hasConvert) {
      execFileSync("convert", [
        "-delay",
        "20",
        "-loop",
        "0",
        "-colors",
        "48",
        ...framePaths,
        "-layers",
        "Optimize",
        outPath,
      ]);
    } else {
      // Fallback: a valid (if static) GIF via sharp's own encoder, so the
      // pool still has a .gif entry when ImageMagick isn't available.
      await sharp(framePaths[0]).gif().toFile(outPath);
    }

    written.push(outPath);
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });

  return written;
}

function generateSvgs(outDir) {
  const svgs = [
    {
      name: "icon-star.svg",
      content: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <polygon points="32,4 40,24 62,24 44,38 51,60 32,47 13,60 20,38 2,24 24,24"
    fill="#f2c94c" stroke="#c9992f" stroke-width="2"/>
</svg>
`,
    },
    {
      name: "icon-badge.svg",
      content: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <circle cx="50" cy="50" r="46" fill="#2980b9"/>
  <circle cx="50" cy="50" r="30" fill="#ecf0f1"/>
  <text x="50" y="58" font-size="28" font-family="sans-serif" text-anchor="middle" fill="#2980b9">B</text>
</svg>
`,
    },
  ];

  const written = [];

  for (const svg of svgs) {
    const outPath = path.join(outDir, svg.name);
    fs.writeFileSync(outPath, svg.content);
    written.push(outPath);
  }

  return written;
}

/**
 * Generates the pool into `outDir` (created if needed), deterministically
 * from `seed`. Returns the list of absolute file paths written.
 */
async function generateMediaPool(outDir, seed) {
  fs.mkdirSync(outDir, { recursive: true });

  // Clean out any stale previous pool so regenerating is idempotent.
  for (const file of fs.readdirSync(outDir)) {
    fs.rmSync(path.join(outDir, file), { force: true });
  }

  const rng = seedrandom(String(seed || "blot-benchmark-media-seed"));

  const photos = await generatePhotos(outDir, rng);
  const gifs = await generateGifs(outDir, rng);
  const svgs = generateSvgs(outDir);

  return [...photos, ...gifs, ...svgs];
}

/**
 * Returns the pool's file list, generating it first if `outDir` doesn't
 * already have one (e.g. this is the first post in this benchmark run that
 * needs media). Safe to call repeatedly/concurrently for the same outDir -
 * only (re)generates when empty.
 */
async function ensureMediaPool(outDir, seed) {
  if (fs.existsSync(outDir)) {
    const existing = fs
      .readdirSync(outDir)
      .filter((name) => !name.startsWith("."))
      .sort()
      .map((name) => path.join(outDir, name));

    if (existing.length) return existing;
  }

  const written = await generateMediaPool(outDir, seed);
  return written.sort();
}

module.exports = { generateMediaPool, ensureMediaPool };

if (require.main === module) {
  const arg = (name, fallback) => {
    const i = process.argv.indexOf(name);
    return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
  };

  const outDir = path.resolve(arg("--out-dir", ".benchmarks/media-pool"));
  const seed = arg("--seed", "blot-benchmark-media-seed");

  generateMediaPool(outDir, seed)
    .then((files) => {
      console.log(`Generated ${files.length} media files into ${outDir}`);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
