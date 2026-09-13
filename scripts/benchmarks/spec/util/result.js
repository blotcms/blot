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
    tagBurst,
    archivesBurst,
    searchBurst,
    sitemapBurst,
    backlinksBurst,
    notFoundBurst,
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
      tags: benchmarkConfig.tags,
      tag_burst_concurrency: benchmarkConfig.tagBurstConcurrency,
      archives_burst_concurrency: benchmarkConfig.archivesBurstConcurrency,
      search_keywords: benchmarkConfig.searchKeywords,
      search_burst_concurrency: benchmarkConfig.searchBurstConcurrency,
      sitemap_burst_concurrency: benchmarkConfig.sitemapBurstConcurrency,
      backlinks_burst_concurrency: benchmarkConfig.backlinksBurstConcurrency,
      not_found_burst_concurrency: benchmarkConfig.notFoundBurstConcurrency,
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
      disk_io: buildPhaseMetrics.disk_io,
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
      disk_io: renderPhaseMetrics.disk_io,
      memory_mb: renderPhaseMetrics.memory_mb,
      bytes: {
        total: renderBytesTotal || 0,
        mean_per_page:
          renderedPages > 0 ? (renderBytesTotal || 0) / renderedPages : 0,
      },
      tag_burst: {
        tags_tested_total: tagBurst.tags_tested_total,
        // Uncontended, one-at-a-time baseline for the same tag pages.
        solo_timing_ms: tagBurst.solo_timing_ms,
        // Same pages requested all at once (Promise.all). A healthy render
        // path keeps this close to the solo timing; queueing behind
        // synchronous, uncached per-request work blows it up.
        burst_timing_ms: tagBurst.burst_timing_ms,
        inflation_ratio: tagBurst.inflation_ratio,
        sites: tagBurst.sites,
      },
      archives_burst: {
        requests_tested_total: archivesBurst.requests_tested_total,
        solo_timing_ms: archivesBurst.solo_timing_ms,
        burst_timing_ms: archivesBurst.burst_timing_ms,
        inflation_ratio: archivesBurst.inflation_ratio,
      },
      search_burst: {
        keywords_tested_total: searchBurst.keywords_tested_total,
        solo_timing_ms: searchBurst.solo_timing_ms,
        burst_timing_ms: searchBurst.burst_timing_ms,
        inflation_ratio: searchBurst.inflation_ratio,
        sites: searchBurst.sites,
      },
      sitemap_burst: {
        requests_tested_total: sitemapBurst.requests_tested_total,
        solo_timing_ms: sitemapBurst.solo_timing_ms,
        burst_timing_ms: sitemapBurst.burst_timing_ms,
        inflation_ratio: sitemapBurst.inflation_ratio,
      },
      backlinks_burst: {
        requests_tested_total: backlinksBurst.requests_tested_total,
        solo_timing_ms: backlinksBurst.solo_timing_ms,
        burst_timing_ms: backlinksBurst.burst_timing_ms,
        inflation_ratio: backlinksBurst.inflation_ratio,
      },
      not_found_burst: {
        requests_tested_total: notFoundBurst.requests_tested_total,
        solo_timing_ms: notFoundBurst.solo_timing_ms,
        burst_timing_ms: notFoundBurst.burst_timing_ms,
        inflation_ratio: notFoundBurst.inflation_ratio,
      },
    },
    sites: siteSummaries,
    status: "pass",
  };
}

module.exports = {
  buildBenchmarkResult,
};
