"use strict";

// The canonical set of metrics the benchmark tooling tracks, compares and
// alerts on. Defined once here so the history file, the PR comment and the
// regression detector never disagree about what "the numbers" are.
//
// `deterministic: true` marks metrics with near-zero run-to-run variance
// (byte sizes), which get the tighter `sizeThresholdPercent` band.

const METRICS = [
  {
    key: "build_p50_ms",
    label: "Build p50 (per site)",
    unit: "ms",
    get: (r) => num(r?.build?.timing_ms?.p50),
  },
  {
    key: "build_p95_ms",
    label: "Build p95 (per site)",
    unit: "ms",
    get: (r) => num(r?.build?.timing_ms?.p95),
  },
  {
    key: "render_p50_ms",
    label: "Render p50 (per page)",
    unit: "ms",
    get: (r) => num(r?.render?.timing_ms?.p50),
  },
  {
    key: "render_p95_ms",
    label: "Render p95 (per page)",
    unit: "ms",
    get: (r) => num(r?.render?.timing_ms?.p95),
  },
  {
    key: "build_peak_rss_mb",
    label: "Build peak RSS",
    unit: "MB",
    get: (r) => num(r?.build?.memory_mb?.peak_rss),
  },
  {
    key: "render_peak_rss_mb",
    label: "Render peak RSS",
    unit: "MB",
    get: (r) => num(r?.render?.memory_mb?.peak_rss),
  },
  {
    key: "render_bytes_mean",
    label: "Output size (per page)",
    unit: "bytes",
    deterministic: true,
    get: (r) => num(r?.render?.bytes?.mean_per_page),
  },
];

const METRIC_BY_KEY = Object.fromEntries(METRICS.map((m) => [m.key, m]));

function num(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

// Flatten a full benchmark-result JSON down to { metricKey: number|null }.
function extractMetrics(result) {
  const out = {};
  for (const metric of METRICS) out[metric.key] = metric.get(result);
  return out;
}

function formatValue(value, unit) {
  if (value === null || value === undefined) return "n/a";

  if (unit === "bytes") {
    if (value >= 1024 * 1024) return (value / (1024 * 1024)).toFixed(2) + " MB";
    if (value >= 1024) return (value / 1024).toFixed(1) + " KB";
    return Math.round(value) + " B";
  }

  if (unit === "MB") return Math.round(value) + " MB";
  if (unit === "ms") return Math.round(value) + " ms";
  return String(value);
}

module.exports = { METRICS, METRIC_BY_KEY, extractMetrics, formatValue };
