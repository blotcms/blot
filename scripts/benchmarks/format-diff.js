"use strict";

const BURSTS = [
  { key: "tag_burst", label: "Tag burst" },
  { key: "archives_burst", label: "Archives burst" },
  { key: "search_burst", label: "Search burst" },
  { key: "sitemap_burst", label: "Sitemap burst" },
  { key: "backlinks_burst", label: "Backlinks burst" },
];

/**
 * Extract summary metrics from a benchmark result JSON (same shape as the
 * table printed at the end of a run).
 */
function metricsFromResult(result) {
  const build = result.build || {};
  const render = result.render || {};
  const buildTiming = build.timing_ms || {};
  const renderTiming = render.timing_ms || {};
  const totalWallMs = (buildTiming.total || 0) + (renderTiming.total || 0);
  const totalCpuMs =
    (build.cpu && (build.cpu.user_ms || 0) + (build.cpu.system_ms || 0)) +
    (render.cpu && (render.cpu.user_ms || 0) + (render.cpu.system_ms || 0));
  const totalCpuPercent =
    totalWallMs > 0 ? (totalCpuMs / totalWallMs) * 100 : 0;
  const totalMemoryMb = Math.max(
    (build.memory_mb && build.memory_mb.peak_rss) || 0,
    (render.memory_mb && render.memory_mb.peak_rss) || 0
  );
  const totalSeconds = totalWallMs / 1000;

  const bursts = {};
  for (const { key } of BURSTS) {
    const burst = render[key] || {};
    const timing = burst.burst_timing_ms || {};
    bursts[key] = {
      p95Ms: timing.p95 != null ? timing.p95 : 0,
      inflationRatio:
        burst.inflation_ratio != null ? burst.inflation_ratio : null,
    };
  }

  return {
    totalCpuPercent,
    totalMemoryMb,
    totalSeconds,
    meanBuildMs: buildTiming.mean != null ? buildTiming.mean : 0,
    meanRenderMs: renderTiming.mean != null ? renderTiming.mean : 0,
    bursts,
  };
}

function fmtNum(n, width) {
  return String(n).padStart(width || 8);
}

function fmtRatio(ratio) {
  return ratio == null ? "n/a" : ratio.toFixed(2);
}

/**
 * Print a comparison table: current -> branch for each metric.
 */
function printCompareTable(currentResult, branchResult) {
  const cur = metricsFromResult(currentResult);
  const br = metricsFromResult(branchResult);
  const label = (s) => ("  " + s).padEnd(26);

  console.log("");
  console.log(
    label("Total CPU") +
      fmtNum(cur.totalCpuPercent.toFixed(2), 8) +
      " %  ->  " +
      fmtNum(br.totalCpuPercent.toFixed(2), 8) +
      " %"
  );
  console.log(
    label("Total Memory") +
      fmtNum(Math.round(cur.totalMemoryMb), 8) +
      " mb  ->  " +
      fmtNum(Math.round(br.totalMemoryMb), 8) +
      " mb"
  );
  console.log("");
  console.log(
    label("Total time") +
      fmtNum(cur.totalSeconds.toFixed(1), 8) +
      " seconds  ->  " +
      fmtNum(br.totalSeconds.toFixed(1), 8) +
      " seconds"
  );
  console.log(
    label("Mean build time") +
      fmtNum(cur.meanBuildMs.toFixed(0), 8) +
      " ms per site  ->  " +
      fmtNum(br.meanBuildMs.toFixed(0), 8) +
      " ms per site"
  );
  console.log(
    label("Mean blog render time") +
      fmtNum(cur.meanRenderMs.toFixed(0), 8) +
      " ms per page  ->  " +
      fmtNum(br.meanRenderMs.toFixed(0), 8) +
      " ms per page"
  );
  console.log("");

  for (const { key, label: burstLabel } of BURSTS) {
    const curBurst = cur.bursts[key];
    const brBurst = br.bursts[key];

    console.log(
      label(`${burstLabel} p95`) +
        fmtNum(curBurst.p95Ms.toFixed(0), 8) +
        " ms  ->  " +
        fmtNum(brBurst.p95Ms.toFixed(0), 8) +
        " ms"
    );
    console.log(
      label(`${burstLabel} inflation`) +
        fmtNum(fmtRatio(curBurst.inflationRatio), 8) +
        "x  ->  " +
        fmtNum(fmtRatio(brBurst.inflationRatio), 8) +
        "x"
    );
  }
  console.log("");
}

module.exports = {
  metricsFromResult,
  printCompareTable,
};
