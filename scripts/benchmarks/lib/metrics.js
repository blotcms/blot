"use strict";

// The canonical set of metrics the benchmark tooling tracks, compares and
// alerts on. Defined once here so the history file, the PR comment and the
// regression detector never disagree about what "the numbers" are.
//
// `deterministic: true` marks metrics with near-zero run-to-run variance
// (byte sizes), which get the tighter `sizeThresholdPercent` band.

// Route types exercised by the concurrent-burst checks. Each one measures a
// solo (uncontended) timing plus a burst (Promise.all) timing for the same
// requests; `inflation_ratio` is burst ÷ solo. Individually they used to each
// get their own p95 + inflation row (12 rows total), which dwarfed the rest
// of the table. They're collapsed into a single averaged inflation metric
// below — the per-route numbers are still in the raw result JSON if you need
// to dig into which route regressed.
const BURST_ROUTES = [
  "tag_burst",
  "archives_burst",
  "search_burst",
  "sitemap_burst",
  "backlinks_burst",
  "not_found_burst",
];

function avgBurstInflation(r) {
  const values = BURST_ROUTES.map((key) => num(r?.render?.[key]?.inflation_ratio)).filter(
    (n) => n !== null
  );
  if (!values.length) return null;
  return values.reduce((sum, n) => sum + n, 0) / values.length;
}

const METRICS = [
  {
    key: "build_p95_ms",
    label: "Build p95 (per site)",
    unit: "ms",
    get: (r) => num(r?.build?.timing_ms?.p95),
  },
  {
    key: "build_peak_rss_mb",
    label: "Build peak RSS",
    unit: "MB",
    get: (r) => num(r?.build?.memory_mb?.peak_rss),
  },
  {
    key: "build_cpu_avg_percent",
    label: "Build CPU (avg, % of machine)",
    unit: "percent",
    get: (r) => num(r?.build?.cpu?.avg_percent_of_machine),
  },
  {
    key: "build_disk_io_ops",
    label: "Build disk I/O (blocks)",
    unit: "ops",
    get: (r) => num(r?.build?.disk_io?.total_ops),
  },
  {
    key: "render_p95_ms",
    label: "Render p95 (per page)",
    unit: "ms",
    get: (r) => num(r?.render?.timing_ms?.p95),
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
  {
    key: "render_cpu_avg_percent",
    label: "Render CPU (avg, % of machine)",
    unit: "percent",
    get: (r) => num(r?.render?.cpu?.avg_percent_of_machine),
  },
  {
    key: "render_disk_io_ops",
    label: "Render disk I/O (blocks)",
    unit: "ops",
    get: (r) => num(r?.render?.disk_io?.total_ops),
  },
  {
    key: "render_burst_inflation_avg",
    label: "Render burst inflation (avg burst ÷ solo, across routes)",
    unit: "ratio",
    get: avgBurstInflation,
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
  if (unit === "ratio") return value.toFixed(2) + "x";
  if (unit === "percent") return value.toFixed(1) + "%";
  if (unit === "ops") return Math.round(value) + " ops";
  return String(value);
}

module.exports = { METRICS, METRIC_BY_KEY, extractMetrics, formatValue };
