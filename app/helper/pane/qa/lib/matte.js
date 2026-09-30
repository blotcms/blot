// Measures a window's alpha independently of the desktop behind it.
//
// The same page (same HTML, CSS and JS) is rendered on a black and on a white desktop.
// For any pixel, with backdrop b and window colour c at opacity a: pixel = a*c + (1-a)*b,
// so a = 1 - (white - black) / 255 exactly, and c = black / a. That gives:
//  - the window's alpha matte, which must be 1 inside the window (no baked-in desktop
//    colour, no accidentally translucent surface), 0 far outside it, and a soft shadow in
//    between; the corners of a rounded window must be transparent
//  - a cut-out of the window with real alpha (cutout.png) that composites onto any image
// See DESIGN.md "Backdrop independence". Surfaces that are meant to be translucent (a
// Mica-like title strip, once a skin does that) are listed in qa/backdrop.json.

const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const { capture } = require("./render");
const { OUT_DIR } = require("./cases");

const INSET = 3; // css px inside the window edge: anti-aliasing of the edge itself
const FAR = 72; // css px outside the window where nothing may be painted (shadows end sooner)
const OPAQUE = 0.98;
const CLEAR = 0.02;
const CORNER = 0.25; // a rounded corner's outermost pixel must be at most this opaque
const SHADOW_EDGE = 0.01; // alpha under which the shadow is counted as ended

const allowed = () => {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, "..", "backdrop.json"), "utf8")).allow || {};
  } catch (e) {
    return {};
  }
};

async function pixels(png) {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, w: info.width, h: info.height };
}

// { id, ... , failures: [string] } or null when the adapter has nothing for the case
async function matte(browser, c, { images = false } = {}) {
  const onBlack = await capture(browser, c, { backdrop: "#000" });
  if (!onBlack) return null;
  const onWhite = await capture(browser, c, { backdrop: "#fff" });
  const [B, W] = [await pixels(onBlack.shot), await pixels(onWhite.shot)];
  if (B.w !== W.w || B.h !== W.h) throw new Error(`${c.id}: the two renders differ in size`);
  const { w, h } = B;
  const s = c.scale;
  const { rect } = onBlack;
  const [rx, ry, rw, rh] = [rect.x * s, rect.y * s, rect.w * s, rect.h * s];

  const alpha = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const d = W.data[i * 4] - B.data[i * 4] + (W.data[i * 4 + 1] - B.data[i * 4 + 1]) + (W.data[i * 4 + 2] - B.data[i * 4 + 2]);
    alpha[i] = Math.min(1, Math.max(0, 1 - d / (3 * 255)));
  }

  const holes = (allowed()[c.id] || []).map((r) => ({ x: r.x * s + rx, y: r.y * s + ry, w: r.w * s, h: r.h * s }));
  const inHole = (x, y) => holes.some((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h);
  const corner = (rect.radius + 2) * s;

  let minInterior = 1;
  let below = 0;
  const box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  let farMax = 0;
  let shadowMax = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const a = alpha[y * w + x];
      const dx = Math.max(rx - x - 1, 0, x - (rx + rw - 1));
      const dy = Math.max(ry - y - 1, 0, y - (ry + rh - 1));
      if (dx > 0 || dy > 0) {
        shadowMax = Math.max(shadowMax, a);
        if (dx / s > FAR || dy / s > FAR) farMax = Math.max(farMax, a);
        continue;
      }
      const [lx, ly] = [x - rx, y - ry];
      if (lx < INSET * s || ly < INSET * s || lx >= rw - INSET * s || ly >= rh - INSET * s) continue;
      if ((lx < corner || lx >= rw - corner) && (ly < corner || ly >= rh - corner)) continue;
      if (inHole(x, y)) continue;
      if (a < minInterior) minInterior = a;
      if (a < OPAQUE) {
        below++;
        box.x0 = Math.min(box.x0, lx); box.y0 = Math.min(box.y0, ly);
        box.x1 = Math.max(box.x1, lx); box.y1 = Math.max(box.y1, ly);
      }
    }
  }

  // how far the shadow reaches from the middle of each side, in css px
  const reach = (x, y, dx, dy) => {
    let n = 0;
    while (x >= 0 && y >= 0 && x < w && y < h && alpha[y * w + x] > SHADOW_EDGE) { x += dx; y += dy; n++; }
    return Math.round((n / s) * 10) / 10;
  };
  const [mx, my] = [Math.round(rx + rw / 2), Math.round(ry + rh / 2)];
  const extents = {
    top: reach(mx, Math.round(ry) - 1, 0, -1),
    right: reach(Math.round(rx + rw), my, 1, 0),
    bottom: reach(mx, Math.round(ry + rh), 0, 1),
    left: reach(Math.round(rx) - 1, my, -1, 0),
  };
  // The corner's alpha: a 3x3 block a tenth of the radius in from the top-left corner. That
  // point is 1.27 radii from the arc's centre, so it is outside any correctly rounded window
  // (alpha ~0) but inside the box (a filled-in corner is opaque there). Not the corner pixel
  // itself: browsers snap a fractional box edge differently, so that pixel can be either.
  const off = Math.max(1, rect.radius * 0.1 * s);
  let cornerAlpha = 0;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) cornerAlpha += alpha[(Math.floor(ry + off) + dy) * w + Math.floor(rx + off) + dx] / 9;

  const failures = [];
  if (minInterior < OPAQUE) {
    const at = `${(box.x0 / s).toFixed(0)},${(box.y0 / s).toFixed(0)} ${((box.x1 - box.x0) / s + 1).toFixed(0)}x${((box.y1 - box.y0) / s + 1).toFixed(0)}`;
    failures.push(`translucent inside the window: ${below} px, min alpha ${minInterior.toFixed(2)}, at ${at} (css px from the window's top-left; list intended ones in qa/backdrop.json)`);
  }
  if (farMax > CLEAR) failures.push(`something is painted more than ${FAR}px outside the window (alpha ${farMax.toFixed(2)}): a baked-in desktop colour?`);
  if (rect.radius >= 6 && cornerAlpha > CORNER) failures.push(`the corner of a ${rect.radius}px-rounded window is not transparent (alpha ${cornerAlpha.toFixed(2)})`);

  if (images) {
    const dir = path.join(OUT_DIR, c.id);
    fs.mkdirSync(dir, { recursive: true });
    const cut = Buffer.alloc(w * h * 4);
    const gray = Buffer.alloc(w * h);
    for (let i = 0; i < w * h; i++) {
      const a = alpha[i];
      for (let k = 0; k < 3; k++) cut[i * 4 + k] = a > 0.004 ? Math.min(255, Math.round(B.data[i * 4 + k] / a)) : 0;
      cut[i * 4 + 3] = Math.round(a * 255);
      gray[i] = Math.round(a * 255);
    }
    await sharp(cut, { raw: { width: w, height: h, channels: 4 } }).png().toFile(path.join(dir, "cutout.png"));
    await sharp(gray, { raw: { width: w, height: h, channels: 1 } }).png().toFile(path.join(dir, "matte.png"));
  }

  return {
    id: c.id,
    radius: rect.radius,
    interior: { minAlpha: minInterior, pixelsBelow: below },
    farMaxAlpha: farMax,
    shadow: { maxAlpha: shadowMax, extent: extents },
    cornerAlpha,
    failures,
  };
}

module.exports = { matte, INSET, FAR, OPAQUE, CLEAR };
