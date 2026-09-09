"use strict";

/**
 * Single source of truth for benchmark knobs.
 *
 * Both the runner (scripts/benchmarks/index.js, runs on the host) and the spec
 * (app/blog/benchmarks/benchmarks.js, runs inside the container) read their
 * defaults from here so the two can never drift apart.
 */
const BENCHMARK_DEFAULTS = Object.freeze({
  // Number of blogs created for the run.
  sites: 5,
  // Total number of generated text entries, spread evenly across sites.
  files: 1000,
  // Deterministic seed for workload generation.
  seed: "blot-benchmark-seed",
  // Concurrency used when replaying sitemap URLs during the render phase.
  renderConcurrency: 8,
  // Concurrency used when writing the generated workload to disk.
  writeConcurrency: 32,
  // How often the phase monitor samples CPU / RSS.
  cpuSampleIntervalMs: 250,
  // Requests issued per sitemap URL per blog during the render phase.
  requestsPerPage: 1,
  // CI gate / trend-alert threshold, in percent, applied to timing metrics.
  regressionThresholdPercent: 15,
  // Tight threshold for near-deterministic metrics (output byte size).
  sizeThresholdPercent: 5,
  // Baseline maturity gate: samples required before an alert can fire.
  minBaselineSamples: 8,
  // How many trailing master samples feed the robust baseline.
  baselineWindow: 20,
  // Consecutive master commits that must all regress before an issue opens.
  regressionConsecutive: 3,
});

module.exports = { BENCHMARK_DEFAULTS };
