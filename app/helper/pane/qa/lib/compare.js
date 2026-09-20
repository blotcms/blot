// Pure image comparison functions. Images are { width, height, data } where
// data is RGBA (Uint8Array / Buffer). Nothing here touches the disk or a
// browser, so everything can be unit-tested with synthetic images.

const pixelmatch = require("pixelmatch");
const { BG } = require("./constants");

const ALPHA = 255;

function createImage(width, height, fill = [...BG, ALPHA]) {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = fill[0];
    data[i + 1] = fill[1];
    data[i + 2] = fill[2];
    data[i + 3] = fill.length > 3 ? fill[3] : ALPHA;
  }
  return { width, height, data };
}

function luma(r, g, b) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function median(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

// Copies `rect` out of `img`. Anything outside the image is filled with `fill`.
function cropImage(img, rect, fill = [...BG, ALPHA]) {
  const out = createImage(rect.w, rect.h, fill);
  for (let y = 0; y < rect.h; y++) {
    const sy = rect.y + y;
    if (sy < 0 || sy >= img.height) continue;
    for (let x = 0; x < rect.w; x++) {
      const sx = rect.x + x;
      if (sx < 0 || sx >= img.width) continue;
      const si = (sy * img.width + sx) * 4;
      const di = (y * rect.w + x) * 4;
      out.data[di] = img.data[si];
      out.data[di + 1] = img.data[si + 1];
      out.data[di + 2] = img.data[si + 2];
      out.data[di + 3] = img.data[si + 3];
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Window rect detection
// ---------------------------------------------------------------------------

// Finds the window on a plain desktop. A drop shadow is a smooth gradient
// while the window edge is a hard step, so instead of "everything that isn't
// the background" (which would swallow the shadow) we walk inwards along
// several lines per side and stop at the first pixel that jumps by more than
// `jump` (sum of channel differences) from its outer neighbour. Lines are
// taken from the middle of each side, away from rounded corners, and the
// median is used so a stray line (e.g. a watermark) can't move the edge.
// Returns { x, y, w, h } in pixels (inclusive of the edge pixels) or null.
function detectWindowRect(img, opts = {}) {
  const jump = opts.jump === undefined ? 36 : opts.jump;
  const fractions = opts.fractions || [0.3, 0.4, 0.5, 0.6, 0.7];
  const { width: w, height: h, data } = img;

  const step = (i, j) =>
    Math.abs(data[i] - data[j]) +
    Math.abs(data[i + 1] - data[j + 1]) +
    Math.abs(data[i + 2] - data[j + 2]);

  // getIndex(d) -> byte offset of the pixel d steps in from the image edge
  function scan(getIndex, length) {
    for (let d = 1; d < length; d++) {
      if (step(getIndex(d - 1), getIndex(d)) > jump) return d;
    }
    return null;
  }

  function side(count, lineIndex) {
    const found = [];
    for (const f of fractions) {
      const d = scan(lineIndex(Math.floor(f * count)), count === w ? h : w);
      if (d !== null) found.push(d);
    }
    return found.length ? median(found) : null;
  }

  const left = side(h, (y) => (d) => (y * w + d) * 4);
  const right = side(h, (y) => (d) => (y * w + (w - 1 - d)) * 4);
  const top = side(w, (x) => (d) => (d * w + x) * 4);
  const bottom = side(w, (x) => (d) => ((h - 1 - d) * w + x) * 4);
  if ([left, right, top, bottom].some((v) => v === null)) return null;

  const rect = {
    x: left,
    y: top,
    w: w - right - left,
    h: h - bottom - top,
  };
  return rect.w > 0 && rect.h > 0 ? rect : null;
}

// ---------------------------------------------------------------------------
// Pixel diff
// ---------------------------------------------------------------------------

function pixelDelta(a, b, i) {
  return Math.max(
    Math.abs(a[i] - b[i]),
    Math.abs(a[i + 1] - b[i + 1]),
    Math.abs(a[i + 2] - b[i + 2])
  );
}

// Diffs two same-sized images with pixelmatch. `ignore` is an optional
// Uint8Array (1 = skip this pixel: masked or outside the window). Returns
//   mask   Uint8Array, 1 where the pixels differ (anti-aliasing tolerated)
//   delta  Uint8Array, max channel difference per pixel
//   count / compared / ratio   differing pixels, pixels compared, count/compared
//   image  visual diff: red = differs, blue tint = ignored, faded original otherwise
function diffImages(a, b, opts = {}) {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(
      `diffImages needs same-sized images (${a.width}x${a.height} vs ${b.width}x${b.height})`
    );
  }
  const threshold = opts.threshold === undefined ? 0.1 : opts.threshold;
  const ignore = opts.ignore || null;
  const { width, height } = a;
  const pixels = width * height;
  const out = new Uint8Array(pixels * 4);
  pixelmatch(a.data, b.data, out, width, height, {
    threshold,
    includeAA: false,
  });

  const mask = new Uint8Array(pixels);
  const delta = new Uint8Array(pixels);
  let count = 0;
  let compared = 0;
  for (let p = 0; p < pixels; p++) {
    const i = p * 4;
    delta[p] = pixelDelta(a.data, b.data, i);
    if (ignore && ignore[p]) {
      // blue tint over the reference so masked areas are obvious
      out[i] = (a.data[i] >> 1) + 30;
      out[i + 1] = (a.data[i + 1] >> 1) + 60;
      out[i + 2] = (a.data[i + 2] >> 1) + 127;
      out[i + 3] = 255;
      continue;
    }
    compared++;
    // pixelmatch paints real differences pure red; the faded background
    // it draws elsewhere is always grey, so this can't be confused.
    if (out[i] === 255 && out[i + 1] === 0 && out[i + 2] === 0) {
      mask[p] = 1;
      count++;
    }
  }
  return {
    mask,
    delta,
    count,
    compared,
    ratio: compared ? count / compared : 0,
    image: { width, height, data: out },
  };
}

// Difference heatmap: how far each pixel is off, not just whether it is.
// Black -> red -> yellow -> white over a dimmed copy of the reference.
function heatmap(a, b, ignore) {
  const { width, height } = a;
  const out = new Uint8Array(width * height * 4);
  for (let p = 0; p < width * height; p++) {
    const i = p * 4;
    const base = luma(a.data[i], a.data[i + 1], a.data[i + 2]) * 0.3;
    let r = base;
    let g = base;
    let bl = base;
    if (ignore && ignore[p]) {
      bl = base + 60;
    } else {
      const t = Math.min(1, Math.sqrt(pixelDelta(a.data, b.data, i) / 160));
      if (t > 0) {
        const hot = [255, Math.max(0, Math.min(255, (t - 0.4) * 425)), Math.max(0, (t - 0.85) * 1700)];
        const w = Math.min(1, t * 1.5);
        r = base * (1 - w) + hot[0] * w;
        g = base * (1 - w) + hot[1] * w;
        bl = base * (1 - w) + hot[2] * w;
      }
    }
    out[i] = r;
    out[i + 1] = g;
    out[i + 2] = Math.min(255, bl);
    out[i + 3] = 255;
  }
  return { width, height, data: out };
}

// diff stats for named rectangles (pixel coordinates). Ignored pixels are not
// counted on either side of the ratio.
function regionStats(diff, ignore, width, height, regions) {
  return regions.map((region) => {
    const x0 = Math.max(0, region.x);
    const y0 = Math.max(0, region.y);
    const x1 = Math.min(width, region.x + region.w);
    const y1 = Math.min(height, region.y + region.h);
    let compared = 0;
    let count = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const p = y * width + x;
        if (ignore && ignore[p]) continue;
        compared++;
        if (diff[p]) count++;
      }
    }
    return {
      name: region.name,
      kind: region.kind,
      rect: { x: region.x, y: region.y, w: region.w, h: region.h },
      compared,
      count,
      ratio: compared ? count / compared : 0,
    };
  });
}

// ---------------------------------------------------------------------------
// Clusters
// ---------------------------------------------------------------------------

// Connected components of differing pixels. Diff pixels within `gap` blocks of
// each other are joined (a glyph's strokes become one blob, not fifty), which
// is done on a coarse grid of block x block pixels for speed. Returns bounding
// boxes (pixel coordinates), the exact number of differing pixels ("area") and
// the mean colour delta over those pixels, largest area first.
function diffClusters(mask, delta, width, height, opts = {}) {
  const block = opts.block || 4;
  const gap = opts.gap === undefined ? 1 : opts.gap;
  const minArea = opts.minArea || 1;
  const gw = Math.ceil(width / block);
  const gh = Math.ceil(height / block);
  const cells = new Uint8Array(gw * gh);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (mask[y * width + x]) cells[Math.floor(y / block) * gw + Math.floor(x / block)] = 1;
    }
  }

  const label = new Int32Array(gw * gh).fill(-1);
  let labels = 0;
  const stack = [];
  for (let start = 0; start < cells.length; start++) {
    if (!cells[start] || label[start] !== -1) continue;
    label[start] = labels;
    stack.push(start);
    while (stack.length) {
      const c = stack.pop();
      const cx = c % gw;
      const cy = (c - cx) / gw;
      for (let dy = -gap; dy <= gap; dy++) {
        for (let dx = -gap; dx <= gap; dx++) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
          const n = ny * gw + nx;
          if (cells[n] && label[n] === -1) {
            label[n] = labels;
            stack.push(n);
          }
        }
      }
    }
    labels++;
  }

  const clusters = [];
  for (let l = 0; l < labels; l++) {
    clusters.push({ x0: Infinity, y0: Infinity, x1: -1, y1: -1, area: 0, sum: 0 });
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      if (!mask[p]) continue;
      const c = clusters[label[Math.floor(y / block) * gw + Math.floor(x / block)]];
      if (x < c.x0) c.x0 = x;
      if (y < c.y0) c.y0 = y;
      if (x > c.x1) c.x1 = x;
      if (y > c.y1) c.y1 = y;
      c.area++;
      c.sum += delta[p];
    }
  }
  return clusters
    .filter((c) => c.area >= minArea)
    .map((c) => ({
      x: c.x0,
      y: c.y0,
      w: c.x1 - c.x0 + 1,
      h: c.y1 - c.y0 + 1,
      area: c.area,
      meanDelta: c.sum / c.area,
    }))
    .sort((a, b) => b.area - a.area || a.y - b.y || a.x - b.x);
}

// ---------------------------------------------------------------------------
// Shadow profile
// ---------------------------------------------------------------------------

// Luminance along lines perpendicular to each window edge, from the first pixel
// outside the window outwards (index 0 = 1px away). Every side averages
// `samples` evenly spaced lines over the middle `span` of the edge, so corners
// (rounded, and where shadows overlap) are left out.
function shadowProfile(img, rect, opts = {}) {
  const distance = opts.distance || 48;
  const samples = opts.samples || 16;
  const span = opts.span || 0.5;
  const { width: w, height: h, data } = img;
  const lumaAt = (x, y) => {
    const i = (y * w + x) * 4;
    return luma(data[i], data[i + 1], data[i + 2]);
  };

  function curve(edgeLength, edgeStart, point, room) {
    const out = [];
    const first = edgeStart + (edgeLength * (1 - span)) / 2;
    const used = Math.min(distance, room);
    for (let d = 1; d <= used; d++) {
      let sum = 0;
      for (let s = 0; s < samples; s++) {
        const along = Math.floor(first + (edgeLength * span * s) / Math.max(1, samples - 1));
        sum += point(along, d);
      }
      out.push(sum / samples);
    }
    return out;
  }

  const right = rect.x + rect.w; // first column outside the window
  const bottom = rect.y + rect.h;
  return {
    top: curve(rect.w, rect.x, (x, d) => lumaAt(x, rect.y - d), rect.y),
    bottom: curve(rect.w, rect.x, (x, d) => lumaAt(x, bottom + d - 1), h - bottom),
    left: curve(rect.h, rect.y, (y, d) => lumaAt(rect.x - d, y), rect.x),
    right: curve(rect.h, rect.y, (y, d) => lumaAt(right + d - 1, y), w - right),
  };
}

const EDGES = ["top", "bottom", "left", "right"];

// Compares two profiles (luminance levels, 0-255). error = RMSE per edge,
// averaged over the edges. `referenceHasShadow` is false for a flat profile
// (Linux captures have none), in which case the error is how much shadow the
// rendering adds. Curves are included so they can be charted.
function shadowError(reference, rendered, opts = {}) {
  const bgLuma = opts.bgLuma === undefined ? luma(...BG) : opts.bgLuma;
  const flat = opts.flatTolerance === undefined ? 1.5 : opts.flatTolerance;
  const hasShadow = (profile) =>
    EDGES.some((e) => profile[e].some((v) => Math.abs(v - bgLuma) > flat));

  const edges = {};
  let total = 0;
  for (const e of EDGES) {
    const n = Math.max(reference[e].length, rendered[e].length);
    let sq = 0;
    let peak = 0;
    for (let i = 0; i < n; i++) {
      // beyond the end of a curve, assume the desktop colour
      const r = i < reference[e].length ? reference[e][i] : bgLuma;
      const d = i < rendered[e].length ? rendered[e][i] : bgLuma;
      sq += (r - d) * (r - d);
      peak = Math.max(peak, Math.abs(r - d));
    }
    const rmse = n ? Math.sqrt(sq / n) : 0;
    edges[e] = { rmse, maxDeviation: peak };
    total += rmse;
  }
  return {
    error: total / EDGES.length,
    edges,
    referenceHasShadow: hasShadow(reference),
    renderedHasShadow: hasShadow(rendered),
    bgLuma,
    curves: { reference, rendered },
  };
}

// ---------------------------------------------------------------------------
// Text rows (compare where text sits, not what the glyphs look like)
// ---------------------------------------------------------------------------

// Bands of pixel rows that contain "ink" inside `rect`: a pixel is ink when it
// differs from that row's dominant luminance by more than `inkDelta`. Ignored
// pixels don't count. Returns [{ y0, y1, x0, x1 }] (rows and columns of the ink).
function textRowBands(img, rect, ignore, opts = {}) {
  const inkDelta = opts.inkDelta || 48;
  const minInk = opts.minInk || 3;
  const joinGap = opts.joinGap === undefined ? 4 : opts.joinGap;
  const { width: w, height: h, data } = img;
  // stay off the window's own edge pixels (border, rounded corners)
  const inset = opts.edgeInset === undefined ? 8 : opts.edgeInset;
  const x0 = Math.max(0, rect.x + inset);
  const x1 = Math.min(w, rect.x + rect.w - inset);
  const y0 = Math.max(0, rect.y);
  const y1 = Math.min(h, rect.y + rect.h);

  const rows = [];
  for (let y = y0; y < y1; y++) {
    const bins = new Map();
    const values = [];
    for (let x = x0; x < x1; x++) {
      const p = y * w + x;
      if (ignore && ignore[p]) {
        values.push(null);
        continue;
      }
      const i = p * 4;
      const l = luma(data[i], data[i + 1], data[i + 2]);
      values.push(l);
      const bin = Math.round(l / 8);
      bins.set(bin, (bins.get(bin) || 0) + 1);
    }
    let modeBin = 0;
    let modeCount = -1;
    for (const [bin, n] of bins) {
      if (n > modeCount) {
        modeCount = n;
        modeBin = bin;
      }
    }
    const modeLuma = modeBin * 8;
    let ink = 0;
    let minX = Infinity;
    let maxX = -1;
    values.forEach((l, k) => {
      if (l !== null && Math.abs(l - modeLuma) > inkDelta) {
        ink++;
        if (x0 + k < minX) minX = x0 + k;
        if (x0 + k > maxX) maxX = x0 + k;
      }
    });
    rows.push(ink >= minInk ? { y, x0: minX, x1: maxX } : null);
  }

  const bands = [];
  let current = null;
  let blanks = 0;
  rows.forEach((row, k) => {
    const y = y0 + k;
    if (row) {
      if (current && blanks <= joinGap) {
        current.y1 = y;
        current.x0 = Math.min(current.x0, row.x0);
        current.x1 = Math.max(current.x1, row.x1);
      } else {
        current = { y0: y, y1: y, x0: row.x0, x1: row.x1 };
        bands.push(current);
      }
      blanks = 0;
    } else {
      blanks++;
    }
  });
  return bands;
}

// Pairs up the bands of two images in order and reports how far apart they
// are. Different band counts are reported, not hidden: `matched` is the number
// of pairs, and offsets are measured on band centres (pixels, vertical) and
// on the left edge of the ink (horizontal).
function compareRowBands(reference, rendered) {
  const matched = Math.min(reference.length, rendered.length);
  let sumY = 0;
  let maxY = 0;
  let sumX = 0;
  let maxX = 0;
  let sumH = 0;
  for (let i = 0; i < matched; i++) {
    const cr = (reference[i].y0 + reference[i].y1) / 2;
    const cd = (rendered[i].y0 + rendered[i].y1) / 2;
    const dy = Math.abs(cr - cd);
    const dx = Math.abs(reference[i].x0 - rendered[i].x0);
    sumY += dy;
    sumX += dx;
    maxY = Math.max(maxY, dy);
    maxX = Math.max(maxX, dx);
    sumH += Math.abs(reference[i].y1 - reference[i].y0 - (rendered[i].y1 - rendered[i].y0));
  }
  return {
    referenceRows: reference.length,
    renderedRows: rendered.length,
    matched,
    meanYOffset: matched ? sumY / matched : 0,
    maxYOffset: maxY,
    meanXOffset: matched ? sumX / matched : 0,
    maxXOffset: maxX,
    meanHeightDelta: matched ? sumH / matched : 0,
  };
}

// ---------------------------------------------------------------------------
// Case comparison
// ---------------------------------------------------------------------------

// Turns window-relative logical-px rectangles ({x|right, y|bottom, w, h}, w/h
// null = to the window edge) into pixel rectangles inside the aligned crop.
function resolveRects(specs, windowW, windowH, scale, margin) {
  return specs.map((s) => {
    const w = s.w === null || s.w === undefined ? windowW - (s.x || 0) : s.w;
    const h = s.h === null || s.h === undefined ? windowH - (s.y || 0) : s.h;
    const x = s.right !== undefined ? windowW - s.right - w : s.x || 0;
    const y = s.bottom !== undefined ? windowH - s.bottom - h : s.y || 0;
    return {
      name: s.name,
      kind: s.kind,
      x: Math.round(margin + x * scale),
      y: Math.round(margin + y * scale),
      w: Math.round(w * scale),
      h: Math.round(h * scale),
    };
  });
}

// Compares a reference screenshot with a rendering of the same case.
//   def: { scale, masks: [...], regions: [...] } (logical px, window-relative)
// Both images are aligned on their detected window rect and cropped to it plus
// `margin` logical px of desktop; stats only cover the window itself.
function compareImages(reference, rendered, def, opts = {}) {
  const scale = def.scale || 2;
  const threshold = opts.threshold === undefined ? 0.1 : opts.threshold;
  const marginPx = Math.round((opts.margin === undefined ? 24 : opts.margin) * scale);

  const refRect = detectWindowRect(reference);
  const rendRect = detectWindowRect(rendered);
  if (!refRect) return { error: "no window found in the reference image" };
  if (!rendRect) return { error: "no window found in the rendered image" };

  const crop = { w: refRect.w + 2 * marginPx, h: refRect.h + 2 * marginPx };
  const refCrop = cropImage(reference, { x: refRect.x - marginPx, y: refRect.y - marginPx, ...crop });
  const rendCrop = cropImage(rendered, { x: rendRect.x - marginPx, y: rendRect.y - marginPx, ...crop });

  const windowW = refRect.w / scale;
  const windowH = refRect.h / scale;
  const masks = resolveRects(def.masks || [], windowW, windowH, scale, marginPx);
  const regions = resolveRects(def.regions || [], windowW, windowH, scale, marginPx);
  const inner = { x: marginPx, y: marginPx, w: refRect.w, h: refRect.h, name: "window", kind: "overall" };

  const ignore = new Uint8Array(crop.w * crop.h);
  for (let y = 0; y < crop.h; y++) {
    for (let x = 0; x < crop.w; x++) {
      if (x < inner.x || y < inner.y || x >= inner.x + inner.w || y >= inner.y + inner.h) {
        ignore[y * crop.w + x] = 1;
      }
    }
  }
  for (const m of masks) {
    for (let y = Math.max(0, m.y); y < Math.min(crop.h, m.y + m.h); y++) {
      for (let x = Math.max(0, m.x); x < Math.min(crop.w, m.x + m.w); x++) {
        ignore[y * crop.w + x] = 1;
      }
    }
  }

  const diff = diffImages(refCrop, rendCrop, { threshold, ignore });
  const stats = regionStats(diff.mask, ignore, crop.w, crop.h, [inner, ...regions]);

  const rowRegion = regions.find((r) => r.kind === "text") || inner;
  const rows = compareRowBands(
    textRowBands(refCrop, rowRegion, ignore),
    textRowBands(rendCrop, rowRegion, ignore)
  );

  const shadow = shadowError(
    shadowProfile(reference, refRect, { distance: opts.shadowDistance || 24 * scale }),
    shadowProfile(rendered, rendRect, { distance: opts.shadowDistance || 24 * scale })
  );

  return {
    scale,
    geometry: {
      referenceRect: refRect,
      renderedRect: rendRect,
      margin: marginPx,
      crop,
      windowLogical: { w: windowW, h: windowH },
      sizeDelta: {
        w: (rendRect.w - refRect.w) / scale,
        h: (rendRect.h - refRect.h) / scale,
      },
    },
    diff: {
      threshold,
      count: diff.count,
      compared: diff.compared,
      percent: diff.ratio * 100,
    },
    regions: stats.slice(1).map((s) => ({ ...s, percent: s.ratio * 100 })),
    rows,
    shadow,
    masks,
    clusters: diffClusters(diff.mask, diff.delta, crop.w, crop.h, opts.clusters),
    images: {
      reference: refCrop,
      rendered: rendCrop,
      diff: diff.image,
      heatmap: heatmap(refCrop, rendCrop, ignore),
    },
  };
}

module.exports = {
  createImage,
  cropImage,
  detectWindowRect,
  diffImages,
  heatmap,
  regionStats,
  diffClusters,
  shadowProfile,
  shadowError,
  textRowBands,
  compareRowBands,
  resolveRects,
  compareImages,
  luma,
};
