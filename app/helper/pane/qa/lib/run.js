// Runs the comparison for one case: loads both images, compares, evaluates the
// thresholds, optionally writes the aligned/diff images to qa/out/<id>/.

const fs = require("fs");
const path = require("path");
const { loadPng, savePng } = require("./image");
const { compareImages } = require("./compare");
const { evaluate, isInformational } = require("./thresholds");
const { OUT_DIR } = require("./cases");

const IMAGES = ["reference", "rendered", "diff", "heatmap"];

function round(value, places = 3) {
  if (typeof value !== "number") return value;
  const f = 10 ** places;
  return Math.round(value * f) / f;
}

function roundDeep(value, places = 3) {
  if (Array.isArray(value)) return value.map((v) => roundDeep(v, places));
  if (value && typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value)) out[k] = roundDeep(value[k], places);
    return out;
  }
  return round(value, places);
}

function outDir(id) {
  return path.join(OUT_DIR, id);
}

// Clusters and rects in the report use logical CSS px relative to the window's
// top-left corner, which is what an agent editing CSS needs.
function toLogical(rect, m) {
  return {
    x: (rect.x - m.margin) / m.scale,
    y: (rect.y - m.margin) / m.scale,
    w: rect.w / m.scale,
    h: rect.h / m.scale,
  };
}

function regionOf(cluster, regions, m) {
  const cx = cluster.x + cluster.w / 2;
  const cy = cluster.y + cluster.h / 2;
  const hit = regions.find(
    (r) => cx >= r.rect.x && cx < r.rect.x + r.rect.w && cy >= r.rect.y && cy < r.rect.y + r.rect.h
  );
  return hit ? hit.name : null;
}

function baseEntry(c, status, extra = {}) {
  return { id: c.id, os: c.os, theme: c.theme, view: c.view, status, ...extra };
}

async function analyze(c, thresholds, opts = {}) {
  if (!fs.existsSync(c.renderedPath)) {
    return baseEntry(c, "missing", { message: "no rendered image (run qa/render.js, or add a fixture)" });
  }
  let result;
  try {
    const [reference, rendered] = await Promise.all([loadPng(c.referencePath), loadPng(c.renderedPath)]);
    result = compareImages(reference, rendered, c, { threshold: opts.threshold });
  } catch (err) {
    return baseEntry(c, "error", { message: err.message });
  }
  if (result.error) return baseEntry(c, "error", { message: result.error });

  const m = { scale: result.scale, margin: result.geometry.margin };
  const entry = {
    ...baseEntry(c, "pass"),
    scale: result.scale,
    geometry: {
      windowLogical: result.geometry.windowLogical,
      sizeDelta: result.geometry.sizeDelta,
      referenceRect: result.geometry.referenceRect,
      renderedRect: result.geometry.renderedRect,
      cropPx: { ...result.geometry.crop, margin: result.geometry.margin },
    },
    diff: result.diff,
    regions: result.regions.map((r) => ({
      name: r.name,
      kind: r.kind,
      rect: r.rect,
      rectLogical: toLogical(r.rect, m),
      compared: r.compared,
      count: r.count,
      percent: r.percent,
      inkPercent: r.inkPercent,
      ink: r.ink,
      flat: r.flat,
      blurMae: r.blurMae,
    })),
    blurMae: result.blurMae,
    rows: result.rows,
    shadow: {
      error: result.shadow.error,
      edges: result.shadow.edges,
      referenceHasShadow: result.shadow.referenceHasShadow,
      renderedHasShadow: result.shadow.renderedHasShadow,
      bgLuma: result.shadow.bgLuma,
      curves: result.shadow.curves,
    },
    masks: result.masks.map((r) => ({ name: r.name, kind: r.kind, ...toLogical(r, m) })),
    clusters: result.clusters.map((cl, i) => {
      const box = toLogical(cl, m);
      return {
        rank: i + 1,
        ...box,
        area: cl.area,
        areaCss: cl.area / (m.scale * m.scale),
        meanDelta: cl.meanDelta,
        region: regionOf(cl, result.regions.map((r) => ({ name: r.name, rect: r.rect })), m),
      };
    }),
  };
  const verdict = evaluate(entry, thresholds);
  const informational = isInformational(thresholds, c.id);
  entry.status = verdict.pass ? "pass" : informational ? "informational" : "fail";
  entry.informational = informational;
  entry.failures = verdict.failures;

  if (opts.writeImages !== false) {
    const dir = outDir(c.id);
    fs.mkdirSync(dir, { recursive: true });
    await Promise.all(IMAGES.map((name) => savePng(result.images[name], path.join(dir, `${name}.png`))));
    fs.writeFileSync(path.join(dir, "report.json"), JSON.stringify(roundDeep(entry), null, 2) + "\n");
  }
  return roundDeep(entry);
}

module.exports = { analyze, roundDeep, outDir, IMAGES };
