"use strict";

const { BENCHMARK_DEFAULTS } = require("./defaults");

// Coerce to a finite number, otherwise fall back to the shared default.
function num(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseBenchmarkConfig(raw = {}) {
  return {
    sites: num(raw.sites, BENCHMARK_DEFAULTS.sites),
    files: num(raw.files, BENCHMARK_DEFAULTS.files),
    seed: String(raw.seed || BENCHMARK_DEFAULTS.seed),
    renderConcurrency: num(
      raw.renderConcurrency,
      BENCHMARK_DEFAULTS.renderConcurrency
    ),
    writeConcurrency: num(
      raw.writeConcurrency,
      BENCHMARK_DEFAULTS.writeConcurrency
    ),
    cpuSampleIntervalMs: num(
      raw.cpuSampleIntervalMs,
      BENCHMARK_DEFAULTS.cpuSampleIntervalMs
    ),
    regressionThresholdPercent: num(
      raw.regressionThresholdPercent,
      BENCHMARK_DEFAULTS.regressionThresholdPercent
    ),
    requestsPerPage: num(
      raw.requestsPerPage,
      BENCHMARK_DEFAULTS.requestsPerPage
    ),
    tags: num(raw.tags, BENCHMARK_DEFAULTS.tags),
    tagBurstConcurrency: num(
      raw.tagBurstConcurrency,
      BENCHMARK_DEFAULTS.tagBurstConcurrency
    ),
    archivesBurstConcurrency: num(
      raw.archivesBurstConcurrency,
      BENCHMARK_DEFAULTS.archivesBurstConcurrency
    ),
    searchKeywords: num(raw.searchKeywords, BENCHMARK_DEFAULTS.searchKeywords),
    searchBurstConcurrency: num(
      raw.searchBurstConcurrency,
      BENCHMARK_DEFAULTS.searchBurstConcurrency
    ),
    backlinksBurstConcurrency: num(
      raw.backlinksBurstConcurrency,
      BENCHMARK_DEFAULTS.backlinksBurstConcurrency
    ),
    sitemapBurstConcurrency: num(
      raw.sitemapBurstConcurrency,
      BENCHMARK_DEFAULTS.sitemapBurstConcurrency
    ),
  };
}

module.exports = {
  parseBenchmarkConfig,
};
