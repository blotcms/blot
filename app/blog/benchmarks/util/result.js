function buildBenchmarkResult(options) {
  const {
    benchmarkConfig,
    workload,
    buildPhaseMetrics,
    buildDurations,
    buildSiteDurations,
    renderPhaseMetrics,
    renderTiming,
    renderBytesTotal,
    siteSummaries,
    renderTasks,
    renderFailures,
  } = options;

  const renderedPages = renderTasks.length;

  return {
    schema_version: 1,
    timestamp: new Date().toISOString(),
    git_sha: process.env.GITHUB_SHA || null,
    config: {
      sites: benchmarkConfig.sites,
      files: benchmarkConfig.files,
      fixture_files_per_site: workload.fixtureCount,
      seed: benchmarkConfig.seed,
      render_concurrency: benchmarkConfig.renderConcurrency,
      requests_per_page: benchmarkConfig.requestsPerPage,
      regression_threshold_percent: benchmarkConfig.regressionThresholdPercent,
      cpu_sample_interval_ms: benchmarkConfig.cpuSampleIntervalMs,
    },
    build: {
      files_total: workload.files.length,
      sites_total: benchmarkConfig.sites,
      timing_ms: {
        total: buildPhaseMetrics.timing_ms.total,
        p50: buildDurations.p50,
        p95: buildDurations.p95,
        mean: buildDurations.mean,
        min: buildDurations.min,
        max: buildDurations.max,
        count: buildDurations.count,
        per_site: buildSiteDurations,
      },
      cpu: buildPhaseMetrics.cpu,
      memory_mb: buildPhaseMetrics.memory_mb,
    },
    render: {
      sitemap_pages_total: renderTasks.length,
      non_2xx_total: renderFailures.length,
      timing_ms: {
        total: renderPhaseMetrics.timing_ms.total,
        p50: renderTiming.p50,
        p95: renderTiming.p95,
        mean: renderTiming.mean,
        min: renderTiming.min,
        max: renderTiming.max,
        count: renderTiming.count,
      },
      cpu: renderPhaseMetrics.cpu,
      memory_mb: renderPhaseMetrics.memory_mb,
      bytes: {
        total: renderBytesTotal || 0,
        mean_per_page:
          renderedPages > 0 ? (renderBytesTotal || 0) / renderedPages : 0,
      },
    },
    sites: siteSummaries,
    status: "pass",
  };
}

module.exports = {
  buildBenchmarkResult,
};
