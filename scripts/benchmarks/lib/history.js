"use strict";

const fs = require("fs");
const path = require("path");

const { median, mad } = require("./stats");
const { METRICS, extractMetrics } = require("./metrics");
const { BENCHMARK_DEFAULTS } = require("../../../app/blog/benchmarks/util/defaults");

// History is one append-only NDJSON file per architecture:
//   <dir>/history-<arch>.ndjson
// Each line is a compact record for one master commit.

function historyPath(dir, arch) {
  return path.join(dir, `history-${arch}.ndjson`);
}

function loadHistory(dir, arch) {
  const file = historyPath(dir, arch);
  if (!fs.existsSync(file)) return [];

  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (err) {
        console.warn(`[history] skipping malformed line ${index + 1}: ${err.message}`);
        return null;
      }
    })
    .filter(Boolean);
}

function recordFromResult(result, extra = {}) {
  return {
    schema_version: BENCHMARK_DEFAULTS.historySchemaVersion,
    git_sha: result.git_sha || process.env.GITHUB_SHA || null,
    timestamp: result.timestamp || new Date().toISOString(),
    arch: extra.arch || null,
    run_id: extra.runId || process.env.GITHUB_RUN_ID || null,
    run_url: extra.runUrl || null,
    iterations: result.iterations || 1,
    metrics: extractMetrics(result),
  };
}

function appendRecord(dir, arch, record) {
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(historyPath(dir, arch), JSON.stringify(record) + "\n");
}

/**
 * Robust baseline from the trailing `window` records: per metric, the median
 * and MAD of the observed values. Excludes the record whose git_sha matches
 * `excludeSha` (so a master run does not compare against itself).
 */
function computeBaseline(records, options = {}) {
  const {
    window = BENCHMARK_DEFAULTS.baselineWindow,
    excludeSha = null,
    schemaVersion = BENCHMARK_DEFAULTS.historySchemaVersion,
  } = options;

  // Records written under an older schema version measured a different set
  // of metrics (or a workload shape that shifts totals), so mixing them into
  // this baseline would make every comparison noise. Excluding them means a
  // schema bump resets the baseline automatically on the next master run,
  // instead of requiring someone to clear the benchmarks-history-* Actions
  // cache by hand.
  const usable = records
    .filter(
      (r) =>
        r &&
        r.metrics &&
        r.schema_version === schemaVersion &&
        (!excludeSha || r.git_sha !== excludeSha)
    )
    .slice(-window);

  const metrics = {};
  for (const metric of METRICS) {
    const values = usable
      .map((r) => r.metrics[metric.key])
      .filter((n) => Number.isFinite(n));

    metrics[metric.key] = values.length
      ? { median: median(values), mad: mad(values), samples: values.length }
      : { median: null, mad: 0, samples: 0 };
  }

  return {
    schema_version: schemaVersion,
    generated_at: new Date().toISOString(),
    window,
    sample_count: usable.length,
    first_sha: usable.length ? usable[0].git_sha : null,
    last_sha: usable.length ? usable[usable.length - 1].git_sha : null,
    metrics,
  };
}

module.exports = {
  historyPath,
  loadHistory,
  recordFromResult,
  appendRecord,
  computeBaseline,
};
