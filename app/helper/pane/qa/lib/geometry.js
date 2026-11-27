// Where the window really sits in a reference image. The nominal padding
// (96px, 80px on Windows) is only approximate (Windows' frame includes an
// invisible border and the capture is not centred exactly), so the renderer
// positions the window at the position detected in the reference.

const { loadPng } = require("./image");
const { detectWindowRect } = require("./compare");

const cache = new Map();

async function referenceGeometry(c) {
  const key = c.referencePath;
  if (!cache.has(key)) {
    cache.set(
      key,
      (async () => {
        const rect = detectWindowRect(await loadPng(c.referencePath));
        if (!rect) throw new Error(`no window found in ${c.referencePath}`);
        return {
          rect,
          origin: { x: rect.x / c.scale, y: rect.y / c.scale },
          size: { width: rect.w / c.scale, height: rect.h / c.scale },
        };
      })()
    );
  }
  return cache.get(key);
}

module.exports = { referenceGeometry };
