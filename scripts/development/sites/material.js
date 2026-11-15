// Source material for the development test sites: the demo folders in
// app/templates/folders and the converters' sample files. Those folders get
// cleaned up from time to time, so nothing here throws when a file has gone.
// Pick material by scanning (texts(), images()) rather than naming files, and
// when a site does need one particular file, copy() it: a missing file is
// skipped with a warning and the site is built without it.

const fs = require("fs-extra");
const { join, extname, relative, dirname } = require("path");

const ROOT = join(__dirname, "../../..");
const FOLDERS = join(ROOT, "app/templates/folders");
const CONVERTERS = join(ROOT, "app/build/converters");

const TEXT = new Set([".txt", ".md", ".markdown"]);
const IMAGE = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp"]);

// Every file under dir, sorted so the result is the same on every run
async function walk(dir) {
  if (!(await fs.pathExists(dir))) return [];
  const results = [];
  for (const item of await fs.readdir(dir, { withFileTypes: true })) {
    if (item.name.startsWith(".")) continue;
    const path = join(dir, item.name);
    if (item.isDirectory()) results.push(...(await walk(path)));
    else results.push(path);
  }
  return results.sort();
}

// Only files inside a demo folder: the README beside them isn't material
const ofType = async (dir, types) =>
  (await walk(dir)).filter(
    (path) => dirname(path) !== dir && types.has(extname(path).toLowerCase())
  );

// Text and image files in the demo folders, as absolute paths
const texts = () => ofType(FOLDERS, TEXT);
const images = () => ofType(FOLDERS, IMAGE);

// The converters' sample files (*.docx, *.odt, ...), leaving out the expected
// output (*.html next to them) and the specs themselves
async function converterSamples() {
  return (await walk(CONVERTERS)).filter(
    (path) =>
      /\/tests?\//.test(path) &&
      !path.endsWith(".js") &&
      !/\.[a-z0-9]+\.html$/i.test(path)
  );
}

// Copies src to dest, making dest's directory. Resolves false, with a warning,
// when src no longer exists.
async function copy(src, dest) {
  if (!(await fs.pathExists(src))) {
    console.warn("Skipping missing material:", relative(ROOT, src));
    return false;
  }
  await fs.ensureDir(dirname(dest));
  await fs.copy(src, dest);
  return true;
}

// A deterministic pseudo-random number generator (mulberry32), so sites that
// shuffle or sample their material come out the same on every run
function random(seed = 1) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

module.exports = {
  ROOT,
  FOLDERS,
  CONVERTERS,
  walk,
  texts,
  images,
  converterSamples,
  copy,
  random,
};
