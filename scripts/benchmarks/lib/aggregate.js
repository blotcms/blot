"use strict";

const { median } = require("./stats");
const { METRICS } = require("./metrics");

// Deep-ish clone good enough for plain JSON.
function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function setPath(obj, dottedPath, value) {
  const parts = dottedPath.split(".");
  let node = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    node[parts[i]] = node[parts[i]] || {};
    node = node[parts[i]];
  }
  node[parts[parts.length - 1]] = value;
}

// Where each tracked metric lives inside a benchmark-result object, so the
// aggregate's headline numbers reflect the per-iteration medians.
const METRIC_PATHS = {
  build_p50_ms: "build.timing_ms.p50",
  build_p95_ms: "build.timing_ms.p95",
  render_p50_ms: "render.timing_ms.p50",
  render_p95_ms: "render.timing_ms.p95",
  build_peak_rss_mb: "build.memory_mb.peak_rss",
  render_peak_rss_mb: "render.memory_mb.peak_rss",
  render_bytes_mean: "render.bytes.mean_per_page",
  build_cpu_avg_percent: "build.cpu.avg_percent_of_machine",
  render_cpu_avg_percent: "render.cpu.avg_percent_of_machine",
  build_disk_io_ops: "build.disk_io.total_ops",
  render_disk_io_ops: "render.disk_io.total_ops",
  // Derived metric (see metrics.js) — has no single home in the raw result
  // schema, so it's stashed under a synthetic path rather than one of the
  // per-route burst objects.
  render_burst_inflation_avg: "render.burst_inflation_avg",
};

/**
 * Combine several single-run results into one. The first run is used as the
 * template; every tracked metric is replaced with the median across runs, and
 * the per-run samples are kept under `samples` for transparency.
 */
function aggregateResults(results) {
  if (!results.length) throw new Error("aggregateResults: no results given");
  if (results.length === 1) {
    const only = clone(results[0]);
    only.iterations = 1;
    return only;
  }

  const merged = clone(results[0]);
  merged.iterations = results.length;
  merged.aggregated_at = new Date().toISOString();

  const samples = {};

  for (const metric of METRICS) {
    const values = results
      .map((r) => metricValue(r, metric.key))
      .filter((n) => Number.isFinite(n));

    samples[metric.key] = values;

    const med = median(values);
    if (med !== null && METRIC_PATHS[metric.key]) {
      setPath(merged, METRIC_PATHS[metric.key], med);
    }
  }

  merged.samples = samples;
  return merged;
}

function metricValue(result, key) {
  const metric = METRICS.find((m) => m.key === key);
  return metric ? metric.get(result) : null;
}

module.exports = { aggregateResults };
